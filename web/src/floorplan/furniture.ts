// Furniture to drag onto a floor plan, at real sizes (metres, width × depth), so a room can be tried out. Sizes are
// common Australian ones; any piece can be resized once it's on the plan. `tall` is a height worth knowing that the
// plan can't show (a fridge has to fit its cavity under the cupboards).

export type FurnitureItem = { key: string; label: string; w: number; h: number; group: Group; round?: boolean; tall?: number };
export type Group = "Bedroom" | "Living" | "Dining" | "Kitchen & laundry" | "Fridges" | "Bathroom" | "Study" | "Outside"
  | "Doors & windows";

export const FURNITURE: FurnitureItem[] = [
  { key: "king", label: "King bed", w: 1.83, h: 2.03, group: "Bedroom" },
  { key: "queen", label: "Queen bed", w: 1.53, h: 2.03, group: "Bedroom" },
  { key: "double", label: "Double bed", w: 1.38, h: 1.88, group: "Bedroom" },
  { key: "king-single", label: "King single", w: 1.06, h: 2.03, group: "Bedroom" },
  { key: "single", label: "Single bed", w: 0.92, h: 1.88, group: "Bedroom" },
  { key: "cot", label: "Cot", w: 0.7, h: 1.3, group: "Bedroom" },
  { key: "bedside", label: "Bedside table", w: 0.45, h: 0.4, group: "Bedroom" },
  { key: "wardrobe", label: "Wardrobe", w: 1.2, h: 0.6, group: "Bedroom" },
  { key: "dresser", label: "Chest of drawers", w: 0.9, h: 0.45, group: "Bedroom" },

  { key: "sofa-3", label: "3-seat sofa", w: 2.2, h: 0.95, group: "Living" },
  { key: "sofa-2", label: "2-seat sofa", w: 1.6, h: 0.9, group: "Living" },
  { key: "corner-sofa", label: "Corner sofa", w: 2.7, h: 1.7, group: "Living" },
  { key: "armchair", label: "Armchair", w: 0.85, h: 0.85, group: "Living" },
  { key: "coffee-table", label: "Coffee table", w: 1.2, h: 0.6, group: "Living" },
  { key: "tv-unit", label: "TV unit", w: 1.8, h: 0.45, group: "Living" },
  { key: "rug", label: "Rug", w: 2.4, h: 1.7, group: "Living" },
  { key: "bookcase", label: "Bookcase", w: 0.9, h: 0.35, group: "Living" },
  { key: "piano", label: "Upright piano", w: 1.5, h: 0.6, group: "Living" },

  { key: "table-4", label: "Dining table (4)", w: 1.2, h: 0.8, group: "Dining" },
  { key: "table-6", label: "Dining table (6)", w: 1.8, h: 0.9, group: "Dining" },
  { key: "table-8", label: "Dining table (8)", w: 2.4, h: 1.0, group: "Dining" },
  { key: "round-table", label: "Round table", w: 1.1, h: 1.1, group: "Dining", round: true },
  { key: "chair", label: "Dining chair", w: 0.45, h: 0.5, group: "Dining" },
  { key: "sideboard", label: "Sideboard", w: 1.6, h: 0.45, group: "Dining" },

  { key: "island", label: "Kitchen island", w: 2.0, h: 0.9, group: "Kitchen & laundry" },
  { key: "washer", label: "Washing machine", w: 0.6, h: 0.65, group: "Kitchen & laundry" },
  { key: "dryer", label: "Dryer", w: 0.6, h: 0.6, group: "Kitchen & laundry" },

  // Typical sizes for each kind (width × depth, and height); models vary, so check the one you have.
  { key: "bar-fridge", label: "Bar fridge", w: 0.5, h: 0.55, tall: 0.85, group: "Fridges" },
  { key: "fridge-small", label: "Top-mount (230 L)", w: 0.55, h: 0.64, tall: 1.45, group: "Fridges" },
  { key: "fridge-medium", label: "Top or bottom mount (350 L)", w: 0.6, h: 0.7, tall: 1.7, group: "Fridges" },
  { key: "fridge-large", label: "Bottom mount (420 L)", w: 0.7, h: 0.73, tall: 1.72, group: "Fridges" },
  { key: "fridge", label: "French door (530 L)", w: 0.84, h: 0.74, tall: 1.79, group: "Fridges" },
  { key: "fridge-sxs", label: "Side by side (650 L)", w: 0.91, h: 0.76, tall: 1.79, group: "Fridges" },
  { key: "fridge-4door", label: "Large French door (700 L)", w: 0.91, h: 0.78, tall: 1.8, group: "Fridges" },
  { key: "fridge-pair", label: "Column fridge + freezer", w: 1.2, h: 0.69, tall: 1.86, group: "Fridges" },

  { key: "bath", label: "Bath", w: 1.7, h: 0.75, group: "Bathroom" },
  { key: "shower", label: "Shower", w: 0.9, h: 0.9, group: "Bathroom" },
  { key: "vanity", label: "Vanity", w: 0.9, h: 0.46, group: "Bathroom" },
  { key: "toilet", label: "Toilet", w: 0.4, h: 0.7, group: "Bathroom" },

  { key: "desk", label: "Desk", w: 1.4, h: 0.7, group: "Study" },
  { key: "office-chair", label: "Office chair", w: 0.65, h: 0.65, group: "Study", round: true },
  { key: "filing", label: "Filing cabinet", w: 0.47, h: 0.62, group: "Study" },

  { key: "car", label: "Car", w: 1.85, h: 4.8, group: "Outside" },
  { key: "suv", label: "Large SUV", w: 1.95, h: 5.0, group: "Outside" },
  { key: "outdoor-table", label: "Outdoor table (6)", w: 1.8, h: 0.9, group: "Outside" },
  { key: "bbq", label: "BBQ", w: 1.4, h: 0.6, group: "Outside" },
  { key: "trampoline", label: "Trampoline", w: 3.0, h: 3.0, group: "Outside", round: true },

  // Plan symbols. A door is as deep as it is wide (its swing); the wall is along its bottom edge.
  { key: "door", label: "Door (820)", w: 0.82, h: 0.82, group: "Doors & windows" },
  { key: "door-wide", label: "Wide door (920)", w: 0.92, h: 0.92, group: "Doors & windows" },
  { key: "double-door", label: "Double doors", w: 1.64, h: 0.82, group: "Doors & windows" },
  { key: "sliding-door", label: "Sliding door", w: 2.1, h: 0.15, group: "Doors & windows" },
  { key: "window", label: "Window", w: 1.2, h: 0.15, group: "Doors & windows" },
  { key: "stairs", label: "Stairs", w: 1.0, h: 3.0, group: "Doors & windows" },
];

export const FURNITURE_BY_KEY = new Map(FURNITURE.map((f) => [f.key, f]));
export const GROUPS: Group[] = ["Bedroom", "Living", "Dining", "Kitchen & laundry", "Fridges", "Bathroom", "Study", "Outside",
  "Doors & windows"];

/** Fill colour per room group, so a busy plan still reads at a glance. */
export const GROUP_COLOUR: Record<Group, string> = {
  Bedroom: "#6d8fd6", Living: "#d98b5f", Dining: "#c9a24a", "Kitchen & laundry": "#5fa58f",
  Fridges: "#7d97a8", Bathroom: "#62a8c9", Study: "#9a7fc9", Outside: "#7f9a6d", "Doors & windows": "#6f757a",
};
