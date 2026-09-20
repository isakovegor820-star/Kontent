export function knowledgeStyleSamples(db: { query(sql: string, params: unknown[]): Promise<{ rows: Array<{ raw_text: string }> }> }, channelId: number, limit?: number): Promise<string[]>;
