import { describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("agent session personalization", () => {
	it("applies configured assistant and user names to the provider-facing text prompt", async () => {
		using tempDir = TempDir.createSync("@pi-agent-personalization-");
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.setRuntimeApiKey("openai", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const settings = Settings.isolated({
			"assistant.name": "Nova",
			"async.enabled": false,
			"user.name": "Riley",
		});
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage,
			modelRegistry,
			settings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			workspaceTree: {
				rootPath: tempDir.path(),
				rendered: "",
				truncated: false,
				totalLines: 0,
				agentsMdFiles: [],
			},
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});

		try {
			const providerPrompt = session.systemPrompt.join("\n\n");
			expect(providerPrompt).toContain("Your name is Nova");
			expect(providerPrompt).toContain("The user's name is Riley");
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});
});
