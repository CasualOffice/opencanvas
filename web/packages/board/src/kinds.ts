// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Built-in diagram kinds (DGM-14). Registered when the board package loads, so every client draws
// them the same whether or not it is in diagram mode (1f). Declarative data only (ADR-045 §3).
import type { Shape } from "./model";
import { kindOf, registerShape, registeredKinds } from "./registry";

/** A visible group with a title (3g): a rect with `label`. 0.1.x clients draw it as a frame. */
export const CONTAINER = "diagram:container";

if (!registeredKinds().includes(CONTAINER)) registerShape({ kind: CONTAINER, base: "rect", version: 1, label: "Container", bindable: true });

export const isContainer = (s: Pick<Shape, "type"> & Partial<Shape>) => kindOf(s) === CONTAINER;
