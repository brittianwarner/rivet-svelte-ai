/**
 * The app's actors. A runner registers them with the engine (`createRegistry`);
 * the browser imports `AppRegistry` as a type only.
 */
export {
  actors,
  createRegistry,
  type AppRegistry,
  type RegistryOptions,
} from "./registry.ts";
export { authorizeConnection, serverActorParams } from "./auth.ts";
export { configureEntityAuth } from "./entity-auth.ts";
export {
  chooseProvider,
  createLanguageModel,
  type ProviderChoice,
} from "./model.ts";
