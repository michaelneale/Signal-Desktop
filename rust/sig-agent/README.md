# sig-agent

Sig's agent loop, built from GDK (goose) crates: `goose-providers` talks to the
model, `goose-provider-types` supplies the conversation and tool types, and this
binary owns the loop. It is the same shape as buzz-agent — goose as a parts bin,
one pinned revision for every goose crate, tools handed back to the host app
instead of executed here.

The model endpoint is any OpenAI-compatible host, for Sig a mesh node
(`mesh-llm serve …` exposes `/v1` locally and routes to the mesh). The one tool,
`group_context`, is never executed by this process: Signal Desktop receives it
over stdout, asks the requester, reads the group on the device, and answers over
stdin. See `src/main.rs` for the line protocol.

```bash
cd rust/sig-agent
cargo build --release            # ~11 MB, rust-toolchain.toml pins 1.95
SIG_AGENT_BASE_URL=http://127.0.0.1:9337/v1 target/release/sig-agent
```

Run Signal Desktop with:

```bash
SIG_MESH_WORKER=1 SIG_MESH_INVITE=… SIG_MESH_SDK_PATH=…   # as before
SIG_AGENT_BIN=$PWD/rust/sig-agent/target/release/sig-agent
SIG_AGENT_BASE_URL=http://127.0.0.1:9337/v1
SIG_AGENT_CONSENT=allow   # optional; omit to get the native consent dialog
```

Without `SIG_AGENT_BIN`/`SIG_AGENT_BASE_URL` the app uses the plain
single-completion path from Phase 1.
