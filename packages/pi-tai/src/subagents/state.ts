export interface AgentRoleState {
  current(): string;
  set(name?: string): void;
}

export function createAgentRoleState(): AgentRoleState {
  let name: string | undefined;
  return {
    current: () => name ?? "standalone",
    set(next) {
      name = next;
    },
  };
}
