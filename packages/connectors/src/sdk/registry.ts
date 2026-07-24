import type { ConnectorPort } from '@careerpilot/application';

/**
 * In-memory registry connectors register into at process startup (worker
 * `main.ts`, task 029). Deliberately not persisted — `connector_configs`
 * (task 027) is the persisted, per-user configuration; this registry is
 * "which connector *implementations* are compiled into this process,"
 * a static fact of the deployed code, not user data.
 */
export class ConnectorRegistry {
  private readonly connectors = new Map<string, ConnectorPort<any>>();

  register(connector: ConnectorPort<any>): void {
    if (this.connectors.has(connector.metadata.key)) {
      throw new Error(
        `Connector key "${connector.metadata.key}" is already registered — connector keys must be globally unique.`,
      );
    }
    this.connectors.set(connector.metadata.key, connector);
  }

  get(key: string): ConnectorPort<any> | undefined {
    return this.connectors.get(key);
  }

  has(key: string): boolean {
    return this.connectors.has(key);
  }

  list(): ConnectorPort<any>[] {
    return [...this.connectors.values()];
  }

  /** Test-only escape hatch — production code never needs to unregister. */
  clear(): void {
    this.connectors.clear();
  }
}

/** Process-wide default registry. Each connector package's index.ts registers into this. */
export const defaultRegistry = new ConnectorRegistry();
