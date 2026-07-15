import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { runCli } from "../src/cli";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const cliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = 0;
});

describe("worker selector CLI dispatch", () => {
	it("fails immediately on an unknown __omp_worker_* selector", async () => {
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		process.exitCode = 0;

		await runCli(["__omp_worker_does_not_exist"]);

		expect(process.exitCode).toBe(1);
		const stderrText = stderr.mock.calls.map(call => String(call[0])).join("");
		expect(stderrText).toContain("Error: unknown worker selector: __omp_worker_does_not_exist");
		expect(stdout).not.toHaveBeenCalled();
	});

	it("preserves normal CLI version handling", async () => {
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		process.exitCode = 0;

		await runCli(["--version"]);

		expect(process.exitCode ?? 0).toBe(0);
		const text = stdout.mock.calls.map(call => String(call[0])).join("");
		expect(text.trim()).toMatch(/^omp\/\d+\.\d+\.\d+(?:[-+][^\s]+)?$/);
	});

	it("child-process: unknown selector exits nonzero with clear stderr", async () => {
		const proc = Bun.spawn({
			cmd: ["bun", cliEntry, "__omp_worker_not_a_real_worker"],
			cwd: path.dirname(cliEntry),
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: path.join(import.meta.dir, ".tmp-worker-selector-agent"),
			},
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("Error: unknown worker selector: __omp_worker_not_a_real_worker");
		expect(stdout).toBe("");
	});
});
