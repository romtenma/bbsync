export const SCHEMA_VERSION = 3 as const;

export type FavoriteLevel = 1 | 2 | 3 | 4 | 5;
export type FilterTargetType = string;
export type FilterEffect = string;

export interface ThreadMetadata {
  readonly title: string;
  readonly url: string;
}

export interface ThreadView {
  readonly position: number;
  readonly firstPosition?: number;
  readonly viewedAt: string;
}

export interface FilterValue {
  readonly effect: FilterEffect;
  readonly isRegex: boolean;
  /** Display metadata only; conflict resolution uses the logical revision. */
  readonly updatedAt: string;
  readonly hitAt?: string;
}

/** A null value clears the entire item. Missing keys make no change. */
export type StateChange =
  | { readonly key: readonly ["metadata", string]; readonly value: ThreadMetadata | null }
  | { readonly key: readonly ["view", string]; readonly value: ThreadView | null }
  | { readonly key: readonly ["count", string]; readonly value: number | null }
  | { readonly key: readonly ["favorite", string]; readonly value: FavoriteLevel | null }
  | { readonly key: readonly ["post", string, number]; readonly value: true | null }
  | { readonly key: readonly ["filter", string, FilterTargetType, string]; readonly value: FilterValue | null };

export type StateKey = StateChange["key"];
export type StateEntry = StateChange & { readonly revision: number };

/** One writer owns each device document and retains every key it has written. */
export interface StateDocument {
  readonly v: typeof SCHEMA_VERSION;
  readonly deviceId: string;
  readonly revision: number;
  readonly entries: readonly StateEntry[];
}

export type MergedEntry = StateEntry & { readonly deviceId: string };

export interface FilterEntry extends FilterValue {
  readonly scope: string;
  readonly targetType: FilterTargetType;
  readonly target: string;
}

export interface ThreadState {
  readonly threadId: string;
  readonly title?: string;
  readonly url?: string;
  readonly lastReadPosition?: number;
  readonly firstReadPosition?: number;
  readonly responseCount?: number;
  readonly lastViewedAt?: string;
  readonly favoriteLevel?: FavoriteLevel;
  readonly postPositions: readonly number[];
}

export interface SynchronizeResult {
  readonly copiedToLeft: number;
  readonly copiedToRight: number;
}
