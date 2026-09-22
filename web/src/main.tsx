import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import { QueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { del, get, set } from "idb-keyval";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 10_000, retry: 1, gcTime: 7 * 24 * 3600_000 } },
});

// Offline read cache (PLAN.md D6): the houses list and every property you've opened are kept in
// IndexedDB, so a dead spot or an auction room still shows them.
const PERSISTED = new Set(["overview", "property", "persons", "views", "places", "inspections", "settings"]);
const persister = createAsyncStoragePersister({
  storage: {
    getItem: async (k) => { try { return (await get<string>(k)) ?? null; } catch { return null; } },
    setItem: async (k, v) => { try { await set(k, v); } catch { /* read cache is best-effort */ } },
    removeItem: async (k) => { try { await del(k); } catch { /* ignore */ } },
  },
  key: "housetrack.cache",
  throttleTime: 2000,
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        maxAge: 7 * 24 * 3600_000,
        dehydrateOptions: { shouldDehydrateQuery: (q) => q.state.status === "success" && PERSISTED.has(String(q.queryKey[0])) },
      }}
    >
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </PersistQueryClientProvider>
  </StrictMode>,
);
