import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  RealmStateError,
  RealmStateStore,
  type RealmConfig,
  type RealmStateStore as RealmStateStoreType,
  type RealmUserConfig,
} from "./realmState.js";

const PROFILES_FILE = "profiles.json";
const PROFILES_SCHEMA_VERSION = "realm-profiles.v1" as const;
const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface RealmProfileRecord {
  profileId: string;
  displayName: string;
  profile?: string;
}

export interface RealmProfileSummary extends RealmProfileRecord {
  storyCursor: number;
}

export interface RealmProfileManagerInput {
  profileId: string;
  displayName: string;
  profile?: string;
}

interface ProfilesFile {
  schemaVersion: typeof PROFILES_SCHEMA_VERSION;
  profiles: RealmProfileRecord[];
}

/** Owns the local profile catalog and one isolated state store per profile. */
export class RealmProfileManager {
  readonly defaultProfileId: string;
  private readonly dataDir: string;
  private readonly baseConfig: RealmConfig;
  private readonly states = new Map<string, RealmStateStoreType>();
  private readonly records = new Map<string, RealmProfileRecord>();
  private readonly rootState: RealmStateStoreType;

  constructor(rootState: RealmStateStoreType) {
    this.rootState = rootState;
    this.dataDir = rootState.dataDirectory();
    this.baseConfig = rootState.config;
    this.defaultProfileId = rootState.config.user.participantId;
    this.states.set(this.defaultProfileId, rootState);

    const loaded = this.loadRecords();
    const defaultRecord: RealmProfileRecord = {
      profileId: this.defaultProfileId,
      displayName: rootState.config.user.displayName,
      ...(rootState.config.user.profile !== undefined
        ? { profile: rootState.config.user.profile }
        : {}),
    };
    this.records.set(this.defaultProfileId, defaultRecord);
    for (const record of loaded) {
      if (record.profileId === this.defaultProfileId) continue;
      this.records.set(record.profileId, record);
      const user: RealmUserConfig = {
        participantId: record.profileId,
        displayName: record.displayName,
        ...(record.profile !== undefined ? { profile: record.profile } : {}),
      };
      this.states.set(
        record.profileId,
        new RealmStateStore(
          join(this.dataDir, "profiles", record.profileId),
          { user, agents: this.baseConfig.agents },
        ),
      );
    }
    this.persistRecords();
  }

  stateFor(profileId = this.defaultProfileId): RealmStateStoreType {
    const state = this.states.get(profileId);
    if (!state) {
      throw new RealmStateError(`unknown profileId: ${profileId}`);
    }
    return state;
  }

  profileFor(profileId = this.defaultProfileId): RealmProfileRecord {
    const record = this.records.get(profileId);
    if (!record) {
      throw new RealmStateError(`unknown profileId: ${profileId}`);
    }
    return { ...record };
  }

  listProfiles(): RealmProfileSummary[] {
    return [...this.records.values()].map((record) => ({
      ...record,
      storyCursor: this.stateFor(record.profileId).storyProgress().cursor,
    }));
  }

  allStates(): readonly RealmStateStoreType[] {
    return [...this.states.values()];
  }

  createProfile(input: RealmProfileManagerInput): RealmProfileSummary {
    validateProfileInput(input);
    if (this.records.has(input.profileId)) {
      throw new RealmStateError(`profileId already exists: ${input.profileId}`);
    }
    const state = new RealmStateStore(
      join(this.dataDir, "profiles", input.profileId),
      {
        user: {
          participantId: input.profileId,
          displayName: input.displayName,
          ...(input.profile !== undefined ? { profile: input.profile } : {}),
        },
        agents: this.baseConfig.agents,
      },
    );
    const record: RealmProfileRecord = {
      profileId: input.profileId,
      displayName: input.displayName,
      ...(input.profile !== undefined ? { profile: input.profile } : {}),
    };
    this.states.set(input.profileId, state);
    this.records.set(input.profileId, record);
    this.persistRecords();
    return { ...record, storyCursor: 0 };
  }

  updateProfile(
    profileId: string,
    input: { displayName: string; profile?: string },
  ): RealmProfileSummary {
    const current = this.profileFor(profileId);
    if (input.displayName.trim().length === 0) {
      throw new RealmStateError("profile displayName must be a non-empty string");
    }
    if (input.profile !== undefined && input.profile.trim().length === 0) {
      throw new RealmStateError("profile profile must be a non-empty string");
    }
    const record: RealmProfileRecord = {
      profileId: current.profileId,
      displayName: input.displayName,
      ...(input.profile !== undefined ? { profile: input.profile } : {}),
    };
    const state = this.stateFor(profileId);
    state.updateUserProfile(record.displayName, record.profile);
    this.records.set(profileId, record);
    this.persistRecords();
    return { ...record, storyCursor: state.storyProgress().cursor };
  }

  private loadRecords(): readonly RealmProfileRecord[] {
    let raw: string;
    try {
      raw = readFileSync(join(this.dataDir, PROFILES_FILE), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new RealmStateError(`cannot read ${PROFILES_FILE}: ${(error as Error).message}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new RealmStateError(`${PROFILES_FILE} is not valid JSON`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new RealmStateError(`${PROFILES_FILE} must be an object`);
    }
    const file = parsed as Record<string, unknown>;
    if (file.schemaVersion !== PROFILES_SCHEMA_VERSION || !Array.isArray(file.profiles)) {
      throw new RealmStateError(`${PROFILES_FILE} has an unsupported schema`);
    }
    const records = file.profiles.map((entry, index) => validateProfileRecord(entry, index));
    if (new Set(records.map((record) => record.profileId)).size !== records.length) {
      throw new RealmStateError(`${PROFILES_FILE} profileId values must be unique`);
    }
    return records;
  }

  private persistRecords(): void {
    mkdirSync(this.dataDir, { recursive: true });
    const file: ProfilesFile = {
      schemaVersion: PROFILES_SCHEMA_VERSION,
      profiles: [...this.records.values()],
    };
    writeFileSync(join(this.dataDir, PROFILES_FILE), `${JSON.stringify(file, null, 2)}\n`);
  }
}

function validateProfileInput(input: RealmProfileManagerInput): void {
  if (!PROFILE_ID_PATTERN.test(input.profileId)) {
    throw new RealmStateError(
      "profileId must start with a letter or number and contain at most 64 ASCII letters, numbers, '.', '_' or '-'.",
    );
  }
  if (input.displayName.trim().length === 0) {
    throw new RealmStateError("profile displayName must be a non-empty string");
  }
  if (input.profile !== undefined && input.profile.trim().length === 0) {
    throw new RealmStateError("profile profile must be a non-empty string");
  }
}

function validateProfileRecord(input: unknown, index: number): RealmProfileRecord {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new RealmStateError(`${PROFILES_FILE}.profiles[${index}] must be an object`);
  }
  const record = input as Record<string, unknown>;
  if (typeof record.profileId !== "string" || !PROFILE_ID_PATTERN.test(record.profileId)) {
    throw new RealmStateError(`${PROFILES_FILE}.profiles[${index}].profileId is invalid`);
  }
  if (typeof record.displayName !== "string" || record.displayName.trim().length === 0) {
    throw new RealmStateError(`${PROFILES_FILE}.profiles[${index}].displayName is invalid`);
  }
  if (record.profile !== undefined && (typeof record.profile !== "string" || record.profile.trim().length === 0)) {
    throw new RealmStateError(`${PROFILES_FILE}.profiles[${index}].profile is invalid`);
  }
  return {
    profileId: record.profileId,
    displayName: record.displayName,
    ...(typeof record.profile === "string" ? { profile: record.profile } : {}),
  };
}
