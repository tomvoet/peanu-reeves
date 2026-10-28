// Runs after runtime.client.ts, which provides the repositories.
export default defineNuxtPlugin(() => {
  void useSync().ready
})
