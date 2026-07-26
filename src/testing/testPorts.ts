import type {
  ActionSink,
  MemoryPort,
  PerceptionPort,
  PlanInput,
  PlanningPort,
  PlanResult,
} from "../ports/ports.js";

export type StaticPerceptionFactory<Perception> = (agentId: string, now: string) => Perception;

export function createStaticPerceptionPort<Perception>(
  perception: Perception | StaticPerceptionFactory<Perception>,
): PerceptionPort<Perception> {
  return {
    perceive: (agentId, now) => {
      if (typeof perception === "function") {
        return (perception as StaticPerceptionFactory<Perception>)(agentId, now);
      }
      return perception;
    },
  };
}

export type StaticPlanFactory<Perception, MemoryHit, ActionProposal> = (
  input: PlanInput<Perception, MemoryHit>,
) => PlanResult<ActionProposal>;

export function createStaticPlanningPort<Perception, MemoryHit, ActionProposal>(
  plan: PlanResult<ActionProposal> | StaticPlanFactory<Perception, MemoryHit, ActionProposal>,
): PlanningPort<Perception, MemoryHit, ActionProposal> {
  return {
    plan: (input) => {
      if (typeof plan === "function") {
        return (plan as StaticPlanFactory<Perception, MemoryHit, ActionProposal>)(input);
      }
      return plan;
    },
  };
}

export interface MemoryRetrievalCall<MemoryQuery> {
  agentId: string;
  query: MemoryQuery;
}

export interface MemoryWriteCall<MemoryWritePayload> {
  agentId: string;
  write: MemoryWritePayload;
}

export type MemoryHitsFactory<MemoryQuery, MemoryHit> = (
  agentId: string,
  query: MemoryQuery,
) => readonly MemoryHit[];

export type MemoryHitsSource<MemoryQuery, MemoryHit> =
  | readonly MemoryHit[]
  | MemoryHitsFactory<MemoryQuery, MemoryHit>;

export interface MemoryPortStubOptions<MemoryQuery, MemoryHit, MemoryWritePayload> {
  hits?: MemoryHitsSource<MemoryQuery, MemoryHit>;
  onRemember?: (agentId: string, write: MemoryWritePayload) => void;
}

export interface MemoryPortStub<MemoryQuery, MemoryHit, MemoryWritePayload> {
  readonly port: MemoryPort<MemoryQuery, MemoryHit, MemoryWritePayload>;
  retrievals(): readonly MemoryRetrievalCall<MemoryQuery>[];
  writes(): readonly MemoryWriteCall<MemoryWritePayload>[];
  setHits(hits: MemoryHitsSource<MemoryQuery, MemoryHit>): void;
  clear(): void;
}

export function createMemoryPortStub<MemoryQuery, MemoryHit, MemoryWritePayload>(
  options: MemoryPortStubOptions<MemoryQuery, MemoryHit, MemoryWritePayload> = {},
): MemoryPortStub<MemoryQuery, MemoryHit, MemoryWritePayload> {
  let hitsSource: MemoryHitsSource<MemoryQuery, MemoryHit> = options.hits ?? [];
  const retrievalCalls: Array<MemoryRetrievalCall<MemoryQuery>> = [];
  const writeCalls: Array<MemoryWriteCall<MemoryWritePayload>> = [];

  return {
    port: {
      retrieve: (agentId, query) => {
        retrievalCalls.push({ agentId, query });
        const hits = typeof hitsSource === "function" ? hitsSource(agentId, query) : hitsSource;
        return [...hits];
      },
      remember: (agentId, write) => {
        writeCalls.push({ agentId, write });
        options.onRemember?.(agentId, write);
      },
    },
    retrievals: () => retrievalCalls.map((call) => ({ ...call })),
    writes: () => writeCalls.map((call) => ({ ...call })),
    setHits: (hits) => {
      hitsSource = hits;
    },
    clear: () => {
      retrievalCalls.length = 0;
      writeCalls.length = 0;
    },
  };
}

export interface CollectedAction<ActionProposal> {
  agentId: string;
  proposal: ActionProposal;
}

export interface ActionCollector<ActionProposal> {
  readonly actionSink: ActionSink<ActionProposal>;
  records(): readonly CollectedAction<ActionProposal>[];
  proposals(): readonly ActionProposal[];
  clear(): void;
}

export function createActionCollector<ActionProposal>(): ActionCollector<ActionProposal> {
  const submitted: Array<CollectedAction<ActionProposal>> = [];

  return {
    actionSink: {
      submit: (agentId, proposal) => {
        submitted.push({ agentId, proposal });
      },
    },
    records: () => submitted.map((record) => ({ ...record })),
    proposals: () => submitted.map((record) => record.proposal),
    clear: () => {
      submitted.length = 0;
    },
  };
}
