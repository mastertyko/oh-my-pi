import { afterEach, describe, expect, it } from "bun:test";
import { configureRecallFeatures } from "@oh-my-pi/pi-mnemopi/config";
import { BeamMemory } from "@oh-my-pi/pi-mnemopi/core/beam";
import { Mnemopi } from "@oh-my-pi/pi-mnemopi/core/memory";
import { orchestrateRecall } from "@oh-my-pi/pi-mnemopi/core/orchestrator";
import { isQueryCacheEnabled } from "@oh-my-pi/pi-mnemopi/core/query-cache";

afterEach(() => {
	delete process.env.MNEMOPI_POLYPHONIC_RECALL;
	delete process.env.MNEMOPI_ENHANCED_RECALL;
	delete process.env.MNEMOPI_PROACTIVE_LINKING;
	configureRecallFeatures({ polyphonicRecall: false, enhancedRecall: false, proactiveLinking: false });
});

describe("per-instance recall feature policy", () => {
	it("keeps concurrent BeamMemory instances independent of process-global configureRecallFeatures", async () => {
		// Poison the process-global defaults — they must not win over instance flags.
		configureRecallFeatures({ polyphonicRecall: true, enhancedRecall: true, proactiveLinking: true });

		const polyOn = new BeamMemory({
			sessionId: "poly-on",
			dbPath: ":memory:",
			polyphonicRecall: true,
			enhancedRecall: false,
		});
		const polyOff = new BeamMemory({
			sessionId: "poly-off",
			dbPath: ":memory:",
			polyphonicRecall: false,
			enhancedRecall: true,
		});
		try {
			expect(polyOn.config.polyphonicRecall).toBe(true);
			expect(polyOn.config.enhancedRecall).toBe(false);
			expect(polyOff.config.polyphonicRecall).toBe(false);
			expect(polyOff.config.enhancedRecall).toBe(true);

			// Query-cache helper honors instance flag when env is unset.
			expect(isQueryCacheEnabled(true, {}, polyOn.config.enhancedRecall)).toBe(false);
			expect(isQueryCacheEnabled(true, {}, polyOff.config.enhancedRecall)).toBe(true);

			// orchestrateRecall routes enhanced only for the instance with enhanced on.
			const enhancedSpyOn = async () => [{ id: "enhanced-on", content: "on", score: 1 }];
			const enhancedSpyOff = async () => [{ id: "enhanced-off", content: "off", score: 1 }];
			const linearSpyOn = async () => [{ id: "linear-on", content: "on", score: 1 }];
			const linearSpyOff = async () => [{ id: "linear-off", content: "off", score: 1 }];

			const beamOn = {
				...polyOn,
				config: polyOn.config,
				async recall(_query: string, _topK?: number) {
					return linearSpyOn();
				},
				async recallEnhanced(_query: string, _topK?: number) {
					return enhancedSpyOn();
				},
			};
			const beamOff = {
				...polyOff,
				config: polyOff.config,
				async recall(_query: string, _topK?: number) {
					return linearSpyOff();
				},
				async recallEnhanced(_query: string, _topK?: number) {
					return enhancedSpyOff();
				},
			};

			// polyOn has polyphonic true → orchestrateRecall uses polyphonic path
			// (not linear/enhanced). polyOff has enhanced true → enhanced path.
			// We forceLinear on polyOn to observe enhanced vs linear independently
			// of the polyphonic engine requiring a real DB.
			const onForcedLinear = await orchestrateRecall(beamOn as never, "q", 3, { forceLinear: true });
			// enhanced false on polyOn → linear
			expect(onForcedLinear[0]?.id).toBe("linear-on");

			const offLinear = await orchestrateRecall(beamOff as never, "q", 3, { forceLinear: true });
			// enhanced true on polyOff → enhanced
			expect(offLinear[0]?.id).toBe("enhanced-off");
		} finally {
			polyOn.close();
			polyOff.close();
		}
	});

	it("hot-patches one Mnemopi instance without mutating a sibling instance", () => {
		const a = new Mnemopi({
			sessionId: "a",
			dbPath: ":memory:",
			bank: "a",
			noEmbeddings: true,
			llm: false,
			polyphonicRecall: true,
			enhancedRecall: true,
			proactiveLinking: true,
		});
		const b = new Mnemopi({
			sessionId: "b",
			dbPath: ":memory:",
			bank: "b",
			noEmbeddings: true,
			llm: false,
			polyphonicRecall: false,
			enhancedRecall: false,
			proactiveLinking: false,
		});
		try {
			expect(a.beam.config.polyphonicRecall).toBe(true);
			expect(b.beam.config.polyphonicRecall).toBe(false);

			a.setRecallFeatures({ polyphonicRecall: false, enhancedRecall: false, proactiveLinking: false });
			expect(a.beam.config.polyphonicRecall).toBe(false);
			expect(a.beam.config.enhancedRecall).toBe(false);
			// sibling unchanged
			expect(b.beam.config.polyphonicRecall).toBe(false);
			expect(b.beam.config.enhancedRecall).toBe(false);

			b.setRecallFeatures({ polyphonicRecall: true, enhancedRecall: true });
			expect(b.beam.config.polyphonicRecall).toBe(true);
			expect(b.beam.config.enhancedRecall).toBe(true);
			expect(a.beam.config.polyphonicRecall).toBe(false);
			expect(a.beam.config.enhancedRecall).toBe(false);
		} finally {
			a.close();
			b.close();
		}
	});

	it("lets env vars override instance feature flags in both directions", () => {
		const beam = new BeamMemory({
			sessionId: "env-override",
			dbPath: ":memory:",
			polyphonicRecall: true,
			enhancedRecall: true,
		});
		try {
			process.env.MNEMOPI_ENHANCED_RECALL = "0";
			expect(isQueryCacheEnabled(true, process.env, beam.config.enhancedRecall)).toBe(false);
			process.env.MNEMOPI_ENHANCED_RECALL = "1";
			const disabled = new BeamMemory({
				sessionId: "env-on-instance-off",
				dbPath: ":memory:",
				enhancedRecall: false,
			});
			try {
				expect(isQueryCacheEnabled(true, process.env, disabled.config.enhancedRecall)).toBe(true);
			} finally {
				disabled.close();
			}
		} finally {
			beam.close();
		}
	});
});
