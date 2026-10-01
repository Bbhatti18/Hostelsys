/** Read every page; never publish a partial financial snapshot after a failure. */
export async function readDashboardRows<T>(query: {
  range: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>;
}) {
  const rows: T[] = [];
  const size = 500;
  for (let from = 0; ; from += size) {
    const result = await query.range(from, from + size - 1);
    if (result.error) return { data: null, error: result.error };
    rows.push(...(result.data ?? []));
    if ((result.data?.length ?? 0) < size) return { data: rows, error: null };
  }
}
