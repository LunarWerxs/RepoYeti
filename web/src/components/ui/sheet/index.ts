import { cva, type VariantProps } from "class-variance-authority"

export { default as Sheet } from "./Sheet.vue"
export { default as SheetClose } from "./SheetClose.vue"
export { default as SheetContent } from "./SheetContent.vue"
export { default as SheetDescription } from "./SheetDescription.vue"
export { default as SheetFooter } from "./SheetFooter.vue"
export { default as SheetHeader } from "./SheetHeader.vue"
export { default as SheetTitle } from "./SheetTitle.vue"
export { default as SheetTrigger } from "./SheetTrigger.vue"

// Unified sheet sides (shared by RepoYeti + DevWebUI). `bottom` is the mobile
// bottom-sheet variant; `right` is the desktop side panel. See UI_UNIFICATION.md §4.
export const sheetVariants = cva(
  "fixed z-50 flex flex-col gap-0 overflow-hidden bg-card shadow-2xl shadow-black/50 transition ease-in-out data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:duration-300 data-[state=closed]:duration-300",
  {
    variants: {
      side: {
        top: "inset-x-0 top-0 h-auto border-b data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top",
        bottom:
          "inset-x-0 bottom-0 h-auto max-h-[92vh] rounded-t-2xl border-t data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom",
        left: "inset-y-0 left-0 h-full w-3/4 border-r sm:max-w-sm data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left",
        right:
          "inset-y-0 right-0 h-full w-full border-l sm:max-w-md data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right",
      },
    },
    defaultVariants: { side: "right" },
  },
)

export type SheetVariants = VariantProps<typeof sheetVariants>
