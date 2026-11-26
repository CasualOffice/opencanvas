// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The sort worker (docs/36 §6.1): sorts key columns off the main thread and reports progress,
// so a 100,000-row table never freezes while it re-orders.

import { sortOrder, type SortJob } from "./sortcore";

interface Msg extends SortJob {
  id: number;
}

self.onmessage = (e: MessageEvent<Msg>) => {
  const { id } = e.data;
  const order = sortOrder(e.data, (p) => (self as unknown as Worker).postMessage({ id, p }));
  (self as unknown as Worker).postMessage({ id, order }, [order.buffer]);
};
