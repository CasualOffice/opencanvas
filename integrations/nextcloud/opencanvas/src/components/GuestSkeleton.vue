<!--
  - SPDX-License-Identifier: Apache-2.0
  - Copyright 2026 CasualOffice
  -
  - S7b: the canvas outline behind the guest name prompt.
  -->
<template>
	<div class="oc-skel" aria-hidden="true">
		<div class="oc-skel__col">
			<span class="oc-skel__b" style="width: 50%; height: 38px" />
			<span class="oc-skel__b" style="width: 30%; height: 12px" />
			<span class="oc-skel__b" style="width: 20%; height: 16px; margin-top: 24px" />
			<span class="oc-skel__b" style="width: 96%; height: 12px" />
			<span class="oc-skel__b" style="width: 88%; height: 12px" />
			<span class="oc-skel__b" style="width: 62%; height: 12px" />
			<span class="oc-skel__b" style="width: 100%; height: 190px; margin-top: 24px; border-radius: 12px" />
		</div>
	</div>
</template>

<script>
export default { name: 'GuestSkeleton' }
</script>

<style scoped>
.oc-skel {
	position: absolute;
	inset: 0;
	background: var(--color-main-background);
	overflow: hidden;
}
.oc-skel__col {
	max-width: 684px;
	margin: 36px auto 0;
	padding: 0 16px;
	display: flex;
	flex-direction: column;
	gap: 10px;
}
.oc-skel__b {
	display: block;
	border-radius: 8px;
	background: var(--color-background-dark);
}
</style>
