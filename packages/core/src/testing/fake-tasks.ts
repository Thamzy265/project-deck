import type { Task, TaskProvider, TaskStatusType } from '../tasks.js';

export class FakeTaskProvider implements TaskProvider {
  readonly id = 'fake';
  private readonly tasks: Map<string, Task>;

  constructor(
    tasks: Task[] = [],
    private readonly configured = true,
  ) {
    this.tasks = new Map(tasks.map((t) => [t.key, { ...t }]));
  }

  isConfigured(): Promise<boolean> {
    return Promise.resolve(this.configured);
  }

  myTasks(filter: { statusTypes?: TaskStatusType[] } = {}): Promise<Task[]> {
    const all = [...this.tasks.values()];
    const wanted = filter.statusTypes;
    return Promise.resolve(
      wanted === undefined ? all : all.filter((t) => wanted.includes(t.statusType)),
    );
  }

  getTask(idOrKey: string): Promise<Task> {
    const task = this.find(idOrKey);
    if (task === undefined) return Promise.reject(new Error(`No task '${idOrKey}'`));
    return Promise.resolve({ ...task });
  }

  setStatus(idOrKey: string, statusType: TaskStatusType): Promise<void> {
    const task = this.find(idOrKey);
    if (task === undefined) return Promise.reject(new Error(`No task '${idOrKey}'`));
    task.statusType = statusType;
    task.status = statusType;
    return Promise.resolve();
  }

  private find(idOrKey: string): Task | undefined {
    return this.tasks.get(idOrKey) ?? [...this.tasks.values()].find((t) => t.id === idOrKey);
  }
}

export function fakeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'issue-uuid-1',
    key: 'ENG-123',
    title: 'Show pending orders on the home screen',
    url: 'https://linear.app/example/issue/ENG-123',
    status: 'Todo',
    statusType: 'unstarted',
    labels: [],
    ...overrides,
  };
}
