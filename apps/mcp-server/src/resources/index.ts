import type { McpRegistry } from '../registry.js';
import type { McpDeps } from '../di.js';
import { makeProfileResource } from './profile.js';
import { makeJobResource } from './job.js';
import { makeApplicationResource } from './application.js';

/** Task 059 §4: `careerpilot://profile/{id}`, `careerpilot://job/{id}`, `careerpilot://application/{id}`. */
export function registerAllResources(registry: McpRegistry, deps: McpDeps): void {
  registry.registerResource(makeProfileResource(deps));
  registry.registerResource(makeJobResource(deps));
  registry.registerResource(makeApplicationResource(deps));
}
