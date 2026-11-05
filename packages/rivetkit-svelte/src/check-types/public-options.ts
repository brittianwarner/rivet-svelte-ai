import type {
  ActionDefaults,
  ActorErrorLike,
  AnyActorRegistry,
  RivetContext,
  RivetKit,
  SvelteRivetKitOptions,
} from "../lib/index.js";
import { createRivetKitWithClient, withActorParams } from "../lib/index.js";
import type { Client } from "rivetkit/client";

type IsAny<T> = 0 extends 1 & T ? true : false;
type ExpectFalse<T extends false> = T;

const clientOptions = {
  actionDefaults: { timeout: 5_000, timeoutByAction: { getSnapshot: 1_000 } },
  connectionInspector: true,
} satisfies SvelteRivetKitOptions<AnyActorRegistry>;

export function configureContext(
  context: RivetContext<AnyActorRegistry>,
): RivetKit<AnyActorRegistry> {
  return context.setup(undefined, clientOptions);
}

export function configureActor(rivet: RivetKit<AnyActorRegistry>): void {
  rivet.createReactiveActor({
    name: "chat" as never,
    key: ["room-1"],
    actionDefaults: { guardConnection: true },
  });
}

const client = {} as Client<AnyActorRegistry>;
const directRivet = createRivetKitWithClient<AnyActorRegistry>(client);
type DirectFactoryResultIsNotAny = ExpectFalse<IsAny<typeof directRivet>>;

// A direct factory call must expose the declared RivetKit surface, not `any`.
directRivet.connectionInspector;
// @ts-expect-error Unknown properties must not pass through an `any` result.
directRivet.notPartOfRivetKit;

const getActorOptions = withActorParams<AnyActorRegistry, never>(
  {
    name: "chat" as never,
    key: ["room-1"],
    actionDefaults: { guardConnection: true },
  },
  { token: "secret" },
);
const preservedActionDefaults: ActionDefaults | undefined =
  getActorOptions().actionDefaults;

// Serialized cross-realm actor errors are structural and need not be Error instances.
const serializedActorError: ActorErrorLike = {
  __type: "RivetError",
  group: "user",
  code: "FORBIDDEN",
  message: "Not allowed",
};

void (0 as unknown as DirectFactoryResultIsNotAny);
void preservedActionDefaults;
void serializedActorError;


// These calls are compile-time contracts, never executed by the application.
import { actor, event, setup } from "rivetkit";
import type { ReactiveActorHandle, ActorState } from "../lib/index.js";
const typedCounter = actor({
  state: { count: 0 },
  events: { changed: event<number>() },
  actions: { increment: (c, by: number) => c.state.count += by },
});
const typedRegistry = setup({ use: { counter: typedCounter } });
function checkActorTypes(handle: ReactiveActorHandle<typeof typedRegistry, "counter">, state: ActorState<typeof typedRegistry, "counter">) {
  const result: Promise<number | undefined> = handle.increment(1);
  const stateResult: Promise<number | undefined> = state.increment(1);
  // @ts-expect-error Incorrect action argument.
  handle.increment("1");
  // @ts-expect-error Unknown action.
  handle.missingAction();
  // @ts-expect-error Incorrect result type.
  const wrong: Promise<string> = handle.increment(1);
  handle.onEvent("changed", (count) => { const value: number = count; void value; });
  // @ts-expect-error Unknown event.
  handle.onEvent("missing", () => {});
  // @ts-expect-error Incorrect event payload.
  handle.onEvent("changed", (count: string) => {});
  void result; void stateResult; void wrong;
}

void checkActorTypes;
