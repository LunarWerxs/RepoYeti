import { ref, watch, type Ref } from "vue";
import { useMediaQuery } from "@vueuse/core";

export type SheetSide = "right" | "bottom";

export function useLockedSheetSide(
  open: Ref<boolean>,
  query = "(min-width: 768px)",
): Ref<SheetSide> {
  const isDesktop = useMediaQuery(query);
  const side = ref<SheetSide>(isDesktop.value ? "right" : "bottom");
  watch(open, (isOpen) => {
    if (isOpen) side.value = isDesktop.value ? "right" : "bottom";
  });
  return side;
}
