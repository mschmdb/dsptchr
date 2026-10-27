const REDACTED_INSPECT = Symbol.for("nodejs.util.inspect.custom");

// Wraps a credential so that logging, JSON or string interpolation never prints it.
export class Secret {
  readonly name: string;
  readonly #value: string;

  constructor(name: string, value: string) {
    this.name = name;
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return `[secret ${this.name}]`;
  }

  toJSON(): string {
    return this.toString();
  }

  [REDACTED_INSPECT](): string {
    return this.toString();
  }
}
