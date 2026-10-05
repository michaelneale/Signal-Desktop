// Copyright 2026 Michael Neale
// SPDX-License-Identifier: AGPL-3.0-only

//! `sig-agent` — Sig's agent loop, built from GDK (goose) parts.
//!
//! The same shape as buzz-agent: **this binary owns the loop; goose is a parts
//! bin.** `goose-providers` talks to the model (an OpenAI-compatible endpoint —
//! for Sig that is a mesh host), `goose-provider-types` gives the conversation
//! and tool types. Everything that decides turn shape lives here: the round
//! bound, cancellation, and the fact that **tools are never executed in this
//! process**. A tool call is emitted to the host app over stdout and the loop
//! waits for the host to answer it (tool-calls-as-output). The host — Signal
//! Desktop — is the only thing that can read Signal data, and it does so only
//! after asking the requester.
//!
//! Wire: one JSON object per line, both directions.
//!
//! ```text
//! stdin  {"type":"turn","id":"t1","model":"m","system":"…","prompt":"…","max_rounds":4}
//! stdout {"type":"delta","id":"t1","text":"…"}                  visible text so far
//! stdout {"type":"tool_call","id":"t1","call_id":"c1","name":"group_context","args":{…}}
//! stdin  {"type":"tool_result","id":"t1","call_id":"c1","content":"…"}   or "error":"…"
//! stdout {"type":"done","id":"t1","text":"…","rounds":2,"tool_calls":1}
//! stdout {"type":"error","id":"t1","error":"…"} | {"type":"cancelled","id":"t1"}
//! stdin  {"type":"cancel","id":"t1"}
//! ```

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use futures::StreamExt;
use goose_provider_types::base::Provider;
use goose_provider_types::conversation::message::{Message, MessageContentBlock};
use goose_provider_types::model::ModelConfig;
use goose_providers::api_client::{ApiClient, AuthMethod};
use goose_providers::openai::{parse_openai_base_url, OpenAiProviderBuilder};
use rmcp::model::{CallToolResult, ContentBlock, ErrorData, Tool};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, Mutex};
use tokio_util::sync::CancellationToken;

const GOOSE_REV: &str = "2f2c92c24c1438cef142476ee6507df82e6c3fba";
const DEFAULT_MAX_ROUNDS: u32 = 4;
const DEFAULT_TIMEOUT_SECS: u64 = 120;
const GROUP_CONTEXT_MAX: u64 = 50;

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Inbound {
    Turn {
        id: String,
        model: String,
        system: String,
        prompt: String,
        max_rounds: Option<u32>,
    },
    ToolResult {
        id: String,
        call_id: String,
        content: Option<String>,
        error: Option<String>,
    },
    Cancel {
        id: String,
    },
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Outbound<'a> {
    Ready {
        goose_rev: &'a str,
        base_url: &'a str,
        tools: Vec<String>,
    },
    Delta {
        id: &'a str,
        text: &'a str,
    },
    ToolCall {
        id: &'a str,
        call_id: &'a str,
        name: &'a str,
        args: &'a Value,
    },
    Done {
        id: &'a str,
        text: &'a str,
        rounds: u32,
        tool_calls: u32,
    },
    Error {
        id: &'a str,
        error: &'a str,
    },
    Cancelled {
        id: &'a str,
    },
}

struct ToolAnswer {
    call_id: String,
    result: Result<String, String>,
}

struct Inflight {
    cancel: CancellationToken,
    tool_tx: mpsc::UnboundedSender<ToolAnswer>,
}

type Out = Arc<Mutex<tokio::io::Stdout>>;

async fn send(out: &Out, message: Outbound<'_>) {
    let mut line = serde_json::to_string(&message).expect("outbound serialises");
    line.push('\n');
    let mut out = out.lock().await;
    let _ = out.write_all(line.as_bytes()).await;
    let _ = out.flush().await;
}

/// The one tool Sig exposes. It is executed by Signal Desktop, never here.
fn tools() -> Vec<Tool> {
    let schema = json!({
        "type": "object",
        "properties": {
            "count": {
                "type": "integer",
                "minimum": 1,
                "maximum": GROUP_CONTEXT_MAX,
                "description": "How many of the most recent messages to read (default 20)."
            }
        },
        "required": []
    });
    let schema = schema
        .as_object()
        .cloned()
        .expect("tool schema is an object");
    vec![Tool::new(
        "group_context",
        "Read the most recent messages in this Signal group so you can answer a question about \
         what was said. Only the requester's own device reads them, and only after the requester \
         approves. Call this when the question refers to the conversation (\"what did we decide\", \
         \"summarise\", \"who said\"); do not call it for general-knowledge questions.",
        Arc::new(schema),
    )]
}

fn build_provider(base_url: &str) -> Result<Arc<dyn Provider>> {
    let (host, _query, has_v1) =
        parse_openai_base_url(base_url).context("SIG_AGENT_BASE_URL is not a valid URL")?;
    let auth = match std::env::var("SIG_AGENT_API_KEY") {
        Ok(key) if !key.trim().is_empty() => AuthMethod::BearerToken(key.trim().to_string()),
        _ => AuthMethod::NoAuth,
    };
    let timeout = std::env::var("SIG_AGENT_TIMEOUT_SECS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(DEFAULT_TIMEOUT_SECS);
    let api_client = ApiClient::with_timeout_and_tls(host, auth, Duration::from_secs(timeout), None)?;
    // `parse_openai_base_url` strips a trailing `/v1`; the provider re-adds it
    // through `base_path` ("v1/chat/completions" vs "chat/completions").
    let base_path = if has_v1 {
        goose_providers::openai::OPEN_AI_DEFAULT_BASE_PATH
    } else {
        goose_providers::openai::OPEN_AI_VERSIONLESS_BASE_PATH
    };
    Ok(Arc::new(
        OpenAiProviderBuilder::new(api_client)
            .name("sig-mesh")
            .base_path(base_path)
            .preserve_thinking_context(true)
            .build(),
    ))
}

fn visible_text(message: &Message) -> String {
    message
        .content
        .iter()
        .filter_map(|block| match block {
            MessageContentBlock::Text(text) => Some(text.text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("")
}

/// Fold a streamed chunk into the message being accumulated (text coalesces,
/// tool calls append) — same rule as buzz-agent's `merge_chunk`.
fn merge_chunk(target: &mut Message, chunk: Message) {
    target.metadata.output_token_limit_reached |= chunk.metadata.output_token_limit_reached;
    for content in chunk.content {
        match (target.content.last_mut(), &content) {
            (Some(MessageContentBlock::Text(last)), MessageContentBlock::Text(new)) => {
                last.text.push_str(&new.text);
            }
            (Some(MessageContentBlock::Thinking(last)), MessageContentBlock::Thinking(new)) => {
                last.thinking.push_str(&new.thinking);
            }
            _ => target.content.push(content),
        }
    }
}

/// Qwen-style inline thinking must not leak into the group.
fn strip_thinking(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(open) = rest.find("<think>") {
        out.push_str(&rest[..open]);
        match rest[open..].find("</think>") {
            Some(close) => rest = &rest[open + close + "</think>".len()..],
            None => {
                rest = "";
                break;
            }
        }
    }
    out.push_str(rest);
    out.trim().to_string()
}

enum RoundOutcome {
    Final(String),
    Cancelled,
}

async fn run_turn(
    provider: Arc<dyn Provider>,
    out: Out,
    id: String,
    model: String,
    system: String,
    prompt: String,
    max_rounds: u32,
    cancel: CancellationToken,
    mut tool_rx: mpsc::UnboundedReceiver<ToolAnswer>,
) -> Result<(RoundOutcome, u32, u32)> {
    let model_config = ModelConfig::new(&model).with_temperature(Some(0.2));
    let tools = tools();
    let mut history: Vec<Message> = vec![Message::user().with_text(&prompt)];
    let mut rounds = 0u32;
    let mut tool_calls = 0u32;
    // Text shown to the requester across rounds: a model that narrates before
    // calling a tool should not have that narration wiped by the next round.
    let mut shown = String::new();

    loop {
        if rounds >= max_rounds {
            return Err(anyhow!("round limit {max_rounds} reached without a final answer"));
        }
        rounds += 1;
        // Tools are offered on every round except the last: the last round must
        // produce an answer, not another request.
        let offered: &[Tool] = if rounds == max_rounds { &[] } else { &tools };

        // Snapshot so the stream's borrow cannot outlive the round.
        let snapshot = history.clone();
        let stream_future = provider.stream(&model_config, &system, &snapshot, offered);
        tokio::pin!(stream_future);
        let mut stream = tokio::select! {
            _ = cancel.cancelled() => return Ok((RoundOutcome::Cancelled, rounds, tool_calls)),
            result = &mut stream_future => result.map_err(|e| anyhow!("{e}"))?,
        };

        let mut accumulated: Option<Message> = None;
        loop {
            tokio::select! {
                _ = cancel.cancelled() => return Ok((RoundOutcome::Cancelled, rounds, tool_calls)),
                next = stream.next() => {
                    let Some(item) = next else { break };
                    let (message, _usage) = item.map_err(|e| anyhow!("{e}"))?;
                    let Some(chunk) = message else { continue };
                    accumulated = Some(match accumulated {
                        None => chunk,
                        Some(mut prev) => { merge_chunk(&mut prev, chunk); prev }
                    });
                    if let Some(acc) = &accumulated {
                        let text = strip_thinking(&visible_text(acc));
                        if !text.is_empty() {
                            let combined = join_shown(&shown, &text);
                            send(&out, Outbound::Delta { id: &id, text: &combined }).await;
                        }
                    }
                }
            }
        }

        drop(stream);
        drop(stream_future);
        let Some(response) = accumulated else {
            return Err(anyhow!("model returned an empty response"));
        };
        let requests: Vec<_> = response
            .content
            .iter()
            .filter_map(|block| match block {
                MessageContentBlock::ToolRequest(request) => Some(request.clone()),
                _ => None,
            })
            .collect();
        let round_text = strip_thinking(&visible_text(&response));
        history.push(response);

        if requests.is_empty() {
            return Ok((RoundOutcome::Final(join_shown(&shown, &round_text)), rounds, tool_calls));
        }
        shown = join_shown(&shown, &round_text);

        // Hand every requested call to the host, then wait for each answer.
        let mut results = Message::user();
        for request in requests {
            tool_calls += 1;
            let call = match &request.tool_call {
                Ok(call) => call,
                Err(error) => {
                    results = results.with_tool_response(
                        request.id.clone(),
                        Err(ErrorData::invalid_params(error.message.to_string(), None)),
                    );
                    continue;
                }
            };
            let args = call
                .arguments
                .clone()
                .map(Value::Object)
                .unwrap_or_else(|| json!({}));
            send(
                &out,
                Outbound::ToolCall { id: &id, call_id: &request.id, name: &call.name, args: &args },
            )
            .await;
            let answer = loop {
                tokio::select! {
                    _ = cancel.cancelled() => return Ok((RoundOutcome::Cancelled, rounds, tool_calls)),
                    answer = tool_rx.recv() => match answer {
                        Some(answer) if answer.call_id == request.id => break answer,
                        Some(_) => continue, // stale answer for another call; drop
                        None => return Err(anyhow!("host closed the tool channel")),
                    }
                }
            };
            let tool_result = match answer.result {
                Ok(content) => Ok(CallToolResult::success(vec![ContentBlock::text(content)])),
                Err(error) => Ok(CallToolResult::error(vec![ContentBlock::text(error)])),
            };
            results = results.with_tool_response(request.id.clone(), tool_result);
        }
        history.push(results);
    }
}

fn join_shown(previous: &str, current: &str) -> String {
    match (previous.is_empty(), current.is_empty()) {
        (true, _) => current.to_string(),
        (_, true) => previous.to_string(),
        _ => format!("{previous}\n\n{current}"),
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let base_url = std::env::var("SIG_AGENT_BASE_URL")
        .context("SIG_AGENT_BASE_URL is required (an OpenAI-compatible mesh endpoint)")?;
    let provider = build_provider(&base_url)?;
    let out: Out = Arc::new(Mutex::new(tokio::io::stdout()));
    let inflight: Arc<Mutex<HashMap<String, Inflight>>> = Arc::new(Mutex::new(HashMap::new()));

    send(
        &out,
        Outbound::Ready {
            goose_rev: GOOSE_REV,
            base_url: &base_url,
            tools: tools().iter().map(|tool| tool.name.to_string()).collect(),
        },
    )
    .await;

    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let inbound: Inbound = match serde_json::from_str(&line) {
            Ok(inbound) => inbound,
            Err(error) => {
                send(&out, Outbound::Error { id: "", error: &format!("bad input: {error}") }).await;
                continue;
            }
        };
        match inbound {
            Inbound::Turn { id, model, system, prompt, max_rounds } => {
                let cancel = CancellationToken::new();
                let (tool_tx, tool_rx) = mpsc::unbounded_channel();
                inflight
                    .lock()
                    .await
                    .insert(id.clone(), Inflight { cancel: cancel.clone(), tool_tx });
                let provider = provider.clone();
                let out = out.clone();
                let inflight = inflight.clone();
                tokio::spawn(async move {
                    let result = run_turn(
                        provider,
                        out.clone(),
                        id.clone(),
                        model,
                        system,
                        prompt,
                        max_rounds.unwrap_or(DEFAULT_MAX_ROUNDS).max(1),
                        cancel,
                        tool_rx,
                    )
                    .await;
                    match result {
                        Ok((RoundOutcome::Final(text), rounds, tool_calls)) => {
                            send(&out, Outbound::Done { id: &id, text: &text, rounds, tool_calls }).await
                        }
                        Ok((RoundOutcome::Cancelled, _, _)) => {
                            send(&out, Outbound::Cancelled { id: &id }).await
                        }
                        Err(error) => {
                            send(&out, Outbound::Error { id: &id, error: &format!("{error:#}") }).await
                        }
                    }
                    inflight.lock().await.remove(&id);
                });
            }
            Inbound::ToolResult { id, call_id, content, error } => {
                if let Some(turn) = inflight.lock().await.get(&id) {
                    let result = match (content, error) {
                        (_, Some(error)) => Err(error),
                        (Some(content), None) => Ok(content),
                        (None, None) => Err("tool returned nothing".to_string()),
                    };
                    let _ = turn.tool_tx.send(ToolAnswer { call_id, result });
                }
            }
            Inbound::Cancel { id } => {
                if let Some(turn) = inflight.lock().await.get(&id) {
                    turn.cancel.cancel();
                } else {
                    send(&out, Outbound::Cancelled { id: &id }).await;
                }
            }
        }
    }
    Ok(())
}
