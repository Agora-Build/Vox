import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

// Execute the production method without starting the daemon's CLI entrypoint.
const source = readFileSync(new URL("../vox_eval_agentd/vox-agentd.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("daemon.ts", source, ts.ScriptTarget.Latest, true);
const daemon = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "VoxEvalAgentDaemon") as ts.ClassDeclaration;
const method = daemon.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(ast) === "exitIfSuperseded")!;
const compiled = ts.transpileModule(`class Subject { ${method.getText(ast)} } Subject;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
function subject(stop: () => Promise<void>) {
  const exit = vi.fn(), log = vi.fn();
  const Subject = runInNewContext(compiled, { process: { exit }, console: { error: log } });
  return { daemon: Object.assign(new Subject(), { stop }), exit };
}

describe("agent supersession cleanup", () => {
  it("waits for the actual asynchronous stop/finalization before exiting", async () => {
    let release!: () => void;
    const stopped = new Promise<void>(resolve => { release = resolve; });
    const stop = vi.fn(() => stopped), test = subject(stop);
    const pending = test.daemon.exitIfSuperseded(new Response('{"superseded":true}', { status: 403 }));
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
    expect(test.exit).not.toHaveBeenCalled();
    release(); await pending;
    expect(test.exit).toHaveBeenCalledWith(1);
  });

  it("still exits if bounded cleanup rejects", async () => {
    const test = subject(async () => { throw new Error("cleanup failed"); });
    await test.daemon.exitIfSuperseded(new Response('{"superseded":true}', { status: 403 }));
    expect(test.exit).toHaveBeenCalledWith(1);
  });

  it.each([new Response('{}', { status: 403 }), new Response('{"superseded":true}', { status: 200 })])(
    "does not stop on an unrelated response", async response => {
      const stop = vi.fn(async () => {}), test = subject(stop);
      await test.daemon.exitIfSuperseded(response);
      expect(stop).not.toHaveBeenCalled(); expect(test.exit).not.toHaveBeenCalled();
    });
});
