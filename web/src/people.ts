import { useQuery } from "@tanstack/react-query";
import { api, getActingPerson, type Person } from "./api";

export function usePersons() {
  return useQuery({ queryKey: ["persons"], queryFn: () => api<Person[]>("/api/persons") });
}

/** Everyone, keyed by id, plus the person using this device. */
export function usePeople() {
  const { data = [] } = usePersons();
  const byId = new Map(data.map((p) => [p.id, p]));
  const me = byId.get(getActingPerson() ?? "") ?? null;
  return { all: data, active: data.filter((p) => p.active), byId, me };
}
