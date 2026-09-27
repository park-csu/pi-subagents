export async function loadFixtureRuntime(onMessage) {
  const { loadExtensions, createExtensionRuntime } = await import(process.env.PI_SUBAGENT_TEST_LOADER);
  const runtime = createExtensionRuntime();
  const allowed = JSON.parse(process.env.PI_SUBAGENT_TOOLS || '["read","bash","delegate","delegate_message"]');
  const messages = [], entries = [], userMessages = [];
  runtime.sendMessage = (message, options) => { messages.push(message); onMessage?.(message, options); };
  runtime.sendUserMessage = (text, options) => userMessages.push({ text, options });
  runtime.appendEntry = (customType, data) => entries.push({ type: "custom", customType, data });
  runtime.getActiveTools = () => allowed;
  runtime.getAllTools = () => ["read", "bash"].map(name => ({ name, sourceInfo: { source: "builtin" } }));
  const loaded = await loadExtensions([process.env.PI_SUBAGENT_TEST_EXTENSION], process.cwd(), undefined, runtime);
  if (loaded.errors.length) throw new Error(JSON.stringify(loaded.errors));
  const extension = loaded.extensions[0];
  const model = { provider: "fixture", id: "model", reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } };
  return {
    extension,
    messages, entries, runtime, userMessages,
    tool: extension.tools.get("delegate")?.definition,
    ctx: { cwd: process.cwd(), mode: "json", hasUI: false, model, thinkingLevel: "xhigh",
      isIdle: () => true, sessionManager: { getBranch: () => entries },
      modelRegistry: { find: () => model } },
  };
}
