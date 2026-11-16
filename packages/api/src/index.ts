/** The HTTP API as Elysia plugins. Dependencies come in; nothing reads the environment. */
export {
  createApi,
  readJson,
  type Api,
  type ApiDependencies,
  type ProviderChoice,
} from "./app.ts";
export { entityRoutes, PERSONAS } from "./entity-routes.ts";
