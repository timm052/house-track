import { useQuery } from "@tanstack/react-query";
import { api, getActingPerson, type Person } from "./api";
import { LIVE } from "./live";

/** Everyone in the household. `live` for a page that edits them (see live.tsx). */
export function usePersons(live = false) {
  return useQuery({ queryKey: ["persons"], queryFn: () => api<Person[]>("/api/persons"), ...(live ? LIVE : {}) });
}

/** Everyone, keyed by id, plus the person using this device. */
export function usePeople() {
  const { data = [] } = usePersons();
  const byId = new Map(data.map((p) => [p.id, p]));
  const me = byId.get(getActingPerson() ?? "") ?? null;
  return { all: data, active: data.filter((p) => p.active), byId, me };
}
