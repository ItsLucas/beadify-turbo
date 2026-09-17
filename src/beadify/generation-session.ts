/** A task may finish or be accepted only against the same document/input revision. */
export type GenerationTicket = { taskId: number; revision: number };
export class GenerationSession {
  private revision = 0;
  private taskId = 0;
  invalidate(): void { this.revision++; this.taskId++; }
  begin(): GenerationTicket { return { taskId: ++this.taskId, revision: this.revision }; }
  isCurrent(ticket: GenerationTicket): boolean {
    return ticket.taskId === this.taskId && ticket.revision === this.revision;
  }
}
