<template>
  <NuxtLink to="/" class="btn ghost back" title="Back to the library">
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M15 18l-6-6 6-6" />
    </svg>
    <span>Library</span>
  </NuxtLink>
</template>

<style scoped>
.back {
  height: 52px;
  padding: 0 16px 0 10px;
  gap: 6px;
  border-radius: 12px;
  font-size: 18px;
}

@media (max-width: 760px) {
  .back span {
    display: none;
  }
}
</style>
