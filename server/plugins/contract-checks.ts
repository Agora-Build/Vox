// Compile-time contract locks between Core seams and the builtin plugins that
// implement them. Type-only: erased at runtime; `npm run check` is the gate.
// (Core→plugin static reference is precedented by plugins/index.ts.)
import type { OrganizationsProvider as CoreOrganizationsContract } from "../organizations";
import type { OrganizationsProvider as PluginOrganizationsContract } from "../../plugins/organizations/server/types";

// The assertion IS the `B extends A` constraint: instantiating this alias with a
// pair that is not assignable is a tsc error at the instantiation site below.
// The body is `never` on both branches — the conditional exists only so `B` is
// referenced (an unused type parameter is an eslint warning, and the constraint
// mechanics are unchanged by it: sabotage-verified by drifting one method of the
// plugin contract and watching `npm run check` fail).
type AssertAssignable<A, B extends A> = B extends A ? never : never;

export type PluginProviderSatisfiesCoreSeam =
  AssertAssignable<CoreOrganizationsContract, PluginOrganizationsContract>;
export type CoreSeamSatisfiesPluginContract =
  AssertAssignable<PluginOrganizationsContract, CoreOrganizationsContract>;
