import { ConsentStateDurableObject } from "../src/consent";

class MemoryStorage {
  private readonly values = new Map<string, unknown>();
  private tail: Promise<void> = Promise.resolve();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }

  async setAlarm(_scheduledTime: number | Date): Promise<void> {}

  async transaction<T>(closure: (transaction: DurableObjectTransaction) => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;

    try {
      return await closure({
        get: <Value>(key: string) => this.get<Value>(key),
        put: <Value>(key: string, value: Value) => this.put(key, value),
        delete: (key: string) => this.delete(key)
      } as unknown as DurableObjectTransaction);
    } finally {
      release();
    }
  }
}

class MemoryStub {
  constructor(private readonly object: ConsentStateDurableObject) {}

  fetch(request: Request): Promise<Response> {
    return Promise.resolve(this.object.fetch(request));
  }
}

export class MemoryConsentNamespace {
  private readonly objects = new Map<string, MemoryStub>();

  idFromName(name: string): string {
    return name;
  }

  get(id: string): MemoryStub {
    let stub = this.objects.get(id);
    if (!stub) {
      const storage = new MemoryStorage();
      const state = { storage } as unknown as DurableObjectState;
      stub = new MemoryStub(new ConsentStateDurableObject(state, {}));
      this.objects.set(id, stub);
    }
    return stub;
  }

  asNamespace(): DurableObjectNamespace {
    return this as unknown as DurableObjectNamespace;
  }
}
