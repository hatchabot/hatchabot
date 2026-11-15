# Curated skills

Choose instructions in an agent's Advanced → Skills. Selecting a pack supplies
a workflow; accounts, tools and provider settings are configured separately.
The library includes Google Workspace, research, browser workflows, writing,
planning, Jira work items and image generation. Cards include setup notes and
example requests; displaying an example does not run it.

## Jira work items

The Jira pack can draft work items from text without any connection. To read or
change real work items, use either an existing Jira connector whose tools are
granted to the conversation, or the agent's own browser:

1. Enable Browser in the agent's Advanced settings.
2. Use Sign in to a site to sign in to the intended Jira site as the account
   the agent should use.
3. Ask for a read-only summary of a known work item before requesting changes.

The pack does not install a connector. An administrator choosing that route
must configure a compatible client/runtime and complete its authorization.
Atlassian publishes a cloud MCP service and its authentication setup in the
[official connection guide](https://developer.atlassian.com/cloud/rovo-mcp/guides/getting-started/).
That service's availability does not establish that a particular Hatchabot
runtime has been connected to it.

For example: “Draft a Jira issue from this bug report with reproduction steps
and acceptance criteria; do not create it.” A live request can instead name an
issue URL and ask for its blockers. The pack directs the agent to check current
state, preview changes that have not yet been authorized, verify results and
avoid duplicate writes after an uncertain response. Jira permissions still
govern access; choosing instructions grants none.

## Image generation

The image pack supports brief drafting without a provider. Actual generation
requires the granted `image_generate` tool, an image-generation provider and
supported credentials. A working chat model is not evidence that image
generation is configured. The ordinary `image` tool analyzes existing images;
it does not generate them.

An administrator configures the provider through OpenClaw's supported auth or
secret settings. The runtime's `image_generate` action `list` reports provider,
model and authentication availability; it does not run a generation. An
administrator may select a default through
`agents.defaults.imageGenerationModel.primary`, using a provider/model that
the installed runtime actually supports. Keep credentials out of skill files
and chat. These tool and setting names were checked against the pinned
[OpenClaw 2026.9.8 implementation](https://github.com/openclaw/openclaw/blob/v2026.9.8/src/agents/tools/image-generate-tool.ts).

For example: “Draft an image brief for a square illustration of a community
garden; do not generate it yet.” Once configured, a request can explicitly
ask for one image. Generation may incur provider charges. The pack limits its
default to one image, handles a delayed task without submitting duplicate
generations, preserves authorized reference requirements and reports the
actual returned artifact. Publishing or sending it elsewhere requires its
own authorization.

## What checks establish

Check availability inspects the running agent's instructions and selected
configuration prerequisites. It does not perform Jira requests, validate an
image-generation charge, or prove an external task succeeds. The separate
isolated protocol test covers all seven instruction reads and scripted tool
calls, including a Jira browser snapshot and image-provider fixtures. Those
fixtures call no actual service. See [live tests](live-tests.md) for the
separate ordinary-model acceptance procedure.
