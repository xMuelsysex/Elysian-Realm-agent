import type { MemoryPort } from "../ports/ports.js";
import {
  type MemoryRecord,
  type MemoryRetrievalHit,
  type MemoryRetrievalQuery,
  type MemoryRetrievalResult,
  type MemoryWrite,
} from "./memoryRecords.js";
import { cloneMemoryRecord, retrieveMemoryRecords } from "./retrieval.js";
import { assertUniqueMemoryId, MemoryValidationError, validateMemoryWrite } from "./validation.js";

export class InMemoryMemoryStore<Metadata = Record<string, unknown>> {
  private readonly records: Array<MemoryRecord<Metadata>> = [];
  private nextGeneratedId = 1;

  constructor(initialRecords: readonly MemoryRecord<Metadata>[] = []) {
    for (const record of initialRecords) {
      this.importRecord(record);
    }
  }

  remember(agentId: string, write: MemoryWrite<Metadata>): MemoryRecord<Metadata> {
    const normalized = validateMemoryWrite(agentId, write);
    const id = normalized.id ?? this.generateId();
    assertUniqueMemoryId(new Set(this.records.map((record) => record.id)), id);

    const record: MemoryRecord<Metadata> = {
      id,
      agentId,
      kind: normalized.kind,
      content: normalized.content,
      createdAt: normalized.createdAt,
      lastAccessedAt: normalized.createdAt,
      importance: normalized.importance,
      sourceIds: [...normalized.sourceIds],
      relatedMemoryIds: [...normalized.relatedMemoryIds],
      visibility: normalized.visibility,
      tags: [...normalized.tags],
      metadata: normalized.metadata,
    };

    this.records.push(record);
    return cloneMemoryRecord(record);
  }

  retrieve(agentId: string, query: MemoryRetrievalQuery): MemoryRetrievalResult<Metadata> {
    const result = retrieveMemoryRecords(this.records, agentId, query);
    this.touchSelected(result.diagnostics.selectedIds, result.diagnostics.query.now);

    return {
      hits: result.hits.map((hit) => {
        const touched = this.records.find((record) => record.id === hit.record.id);
        return {
          record: cloneMemoryRecord(touched ?? hit.record),
          score: { ...hit.score },
        };
      }),
      diagnostics: {
        ...result.diagnostics,
        query: {
          ...result.diagnostics.query,
          tags: [...result.diagnostics.query.tags],
          sourceIds: [...result.diagnostics.query.sourceIds],
          weights: { ...result.diagnostics.query.weights },
        },
        candidateIds: [...result.diagnostics.candidateIds],
        selectedIds: [...result.diagnostics.selectedIds],
        candidateScores: result.diagnostics.candidateScores.map((entry) => ({
          memoryId: entry.memoryId,
          score: { ...entry.score },
        })),
        excluded: result.diagnostics.excluded.map((entry) => ({ ...entry })),
      },
    };
  }

  list(agentId: string): readonly MemoryRecord<Metadata>[] {
    return this.records
      .filter((record) => record.agentId === agentId)
      .map((record) => cloneMemoryRecord(record));
  }

  toPort(): MemoryPort<MemoryRetrievalQuery, MemoryRetrievalHit<Metadata>, MemoryWrite<Metadata>> {
    return {
      retrieve: (agentId, query) => this.retrieve(agentId, query).hits,
      remember: (agentId, write) => {
        this.remember(agentId, write);
      },
    };
  }

  private touchSelected(memoryIds: readonly string[], now: string): void {
    const selectedIds = new Set(memoryIds);
    for (let index = 0; index < this.records.length; index += 1) {
      const record = this.records[index];
      if (!selectedIds.has(record.id)) {
        continue;
      }

      this.records[index] = {
        ...record,
        lastAccessedAt: now,
        sourceIds: [...record.sourceIds],
        relatedMemoryIds: [...record.relatedMemoryIds],
        tags: [...record.tags],
      };
    }
  }

  private importRecord(record: MemoryRecord<Metadata>): void {
    const normalized = validateMemoryWrite(record.agentId, {
      id: record.id,
      kind: record.kind,
      content: record.content,
      createdAt: record.createdAt,
      importance: record.importance,
      sourceIds: record.sourceIds,
      relatedMemoryIds: record.relatedMemoryIds,
      visibility: record.visibility,
      tags: record.tags,
      metadata: record.metadata,
    });
    if (typeof record.lastAccessedAt !== "string" || Number.isNaN(Date.parse(record.lastAccessedAt))) {
      throw new MemoryValidationError(["record.lastAccessedAt must be a valid ISO date string"]);
    }
    assertUniqueMemoryId(new Set(this.records.map((existingRecord) => existingRecord.id)), record.id);

    this.records.push({
      id: record.id,
      agentId: record.agentId,
      kind: normalized.kind,
      content: normalized.content,
      createdAt: normalized.createdAt,
      lastAccessedAt: record.lastAccessedAt,
      importance: normalized.importance,
      sourceIds: [...normalized.sourceIds],
      relatedMemoryIds: [...normalized.relatedMemoryIds],
      visibility: normalized.visibility,
      tags: [...normalized.tags],
      metadata: normalized.metadata,
    });
  }

  private generateId(): string {
    let id = "";
    do {
      id = `memory_${String(this.nextGeneratedId).padStart(4, "0")}`;
      this.nextGeneratedId += 1;
    } while (this.records.some((record) => record.id === id));
    return id;
  }
}
