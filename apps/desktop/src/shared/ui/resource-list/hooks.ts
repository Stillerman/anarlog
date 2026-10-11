import { useQuery } from "@tanstack/react-query";

export function useWebResources<T>(endpoint: string) {
  return useQuery({
    queryKey: ["settings", endpoint, "suggestions"],
    // This fork has no upstream resource-suggestion service.
    queryFn: async (): Promise<T[]> => [],
  });
}
