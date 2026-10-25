// Furniture to drag onto a floor plan, at real sizes (metres, width × depth), so a room can be tried out. Sizes are
// common Australian ones; any piece can be resized once it's on the plan. `tall` is a height worth knowing that the
// plan can't show (a fridge has to fit its cavity under the cupboards).

export type FurnitureItem = { key: string; label: string; w: number; h: number; group: Group; round?: boolean; tall?: number };
export type Group = "Custom" | "Bedroom" | "Living" | "Dining" | "Kitchen & laundry" | "Fridges" | "Bathroom" | "Study" | "Workshop"
  | "3D printing & CNC" | "Pottery studio" | "Cars" | "Outside" | "Animals" | "Doors & windows";

export const FURNITURE: FurnitureItem[] = [
  // Anything that isn't in the list: name it and size it once it's on the plan.
  { key: "custom-box", label: "Custom item", w: 1.0, h: 0.6, group: "Custom" },
  { key: "custom-round", label: "Custom round item", w: 0.8, h: 0.8, round: true, group: "Custom" },

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

  // A workshop: benches and storage, then the bigger power tools at their footprint in use (a table saw with its rails,
  // a mitre saw on a stand with its wings). Leave room to feed long boards in and out of the saws and the jointer.
  { key: "workbench", label: "Workbench", w: 1.8, h: 0.75, tall: 0.9, group: "Workshop" },
  { key: "workbench-large", label: "Large workbench", w: 2.4, h: 0.9, tall: 0.9, group: "Workshop" },
  { key: "woodwork-bench", label: "Woodwork bench (vices)", w: 1.8, h: 0.6, tall: 0.88, group: "Workshop" },
  { key: "assembly-table", label: "Assembly / outfeed table", w: 1.8, h: 1.2, tall: 0.86, group: "Workshop" },
  { key: "tool-chest", label: "Tool chest", w: 1.05, h: 0.46, tall: 1.0, group: "Workshop" },
  { key: "shelving", label: "Shelving", w: 1.8, h: 0.5, tall: 1.8, group: "Workshop" },
  { key: "table-saw", label: "Table saw (with rails)", w: 1.4, h: 0.85, tall: 0.86, group: "Workshop" },
  { key: "jobsite-saw", label: "Jobsite table saw", w: 0.65, h: 0.6, tall: 0.86, group: "Workshop" },
  { key: "mitre-saw", label: "Mitre saw on stand", w: 2.4, h: 0.6, tall: 0.95, group: "Workshop" },
  { key: "bandsaw", label: "Bandsaw", w: 0.65, h: 0.6, tall: 1.8, group: "Workshop" },
  { key: "drill-press", label: "Drill press (floor)", w: 0.5, h: 0.7, tall: 1.65, group: "Workshop" },
  { key: "jointer", label: "Jointer", w: 1.5, h: 0.5, tall: 0.82, group: "Workshop" },
  { key: "planer", label: "Thicknesser", w: 0.6, h: 0.65, tall: 0.95, group: "Workshop" },
  { key: "lathe", label: "Wood lathe", w: 1.8, h: 0.5, tall: 1.15, group: "Workshop" },
  { key: "metal-lathe", label: "Metal lathe", w: 1.6, h: 0.7, tall: 1.4, group: "Workshop" },
  { key: "mini-lathe", label: "Mini lathe (benchtop)", w: 0.9, h: 0.4, tall: 0.4, group: "Workshop" },
  { key: "dust-extractor", label: "Dust extractor", w: 0.6, h: 0.6, tall: 1.9, round: true, group: "Workshop" },
  { key: "compressor", label: "Air compressor", w: 0.75, h: 0.4, tall: 0.7, group: "Workshop" },

  // Footprints with room for the bed or gantry to travel, which is more than the frame (a bed-slinger needs its
  // bed's travel clear behind and in front).
  { key: "printer-open", label: "3D printer (open frame)", w: 0.5, h: 0.6, tall: 0.6, group: "3D printing & CNC" },
  { key: "printer-enclosed", label: "3D printer (enclosed)", w: 0.45, h: 0.5, tall: 0.6, group: "3D printing & CNC" },
  { key: "printer-large", label: "Large 3D printer", w: 0.7, h: 0.7, tall: 0.8, group: "3D printing & CNC" },
  { key: "resin-printer", label: "Resin printer + wash/cure", w: 0.6, h: 0.35, tall: 0.45, group: "3D printing & CNC" },
  { key: "cnc-desktop", label: "Desktop CNC (enclosed)", w: 0.7, h: 0.7, tall: 0.65, group: "3D printing & CNC" },
  { key: "cnc-open", label: "CNC router (open, 1 m)", w: 1.1, h: 1.0, tall: 0.5, group: "3D printing & CNC" },
  { key: "laser-desktop", label: "Diode laser (enclosed)", w: 0.7, h: 0.65, tall: 0.35, group: "3D printing & CNC" },
  { key: "laser-co2", label: "CO₂ laser cutter", w: 1.0, h: 0.6, tall: 0.45, group: "3D printing & CNC" },

  // A pottery studio. Kilns need about 0.45 m clear on every side, and an extraction hood over them.
  { key: "pottery-wheel", label: "Pottery wheel (with stool)", w: 0.65, h: 1.1, tall: 0.6, group: "Pottery studio" },
  { key: "kiln-top", label: "Kiln (top loading)", w: 0.8, h: 0.8, tall: 1.0, round: true, group: "Pottery studio" },
  { key: "kiln-front", label: "Kiln (front loading)", w: 0.9, h: 0.9, tall: 1.6, group: "Pottery studio" },
  { key: "wedging-table", label: "Wedging table", w: 0.9, h: 0.6, tall: 0.8, group: "Pottery studio" },
  { key: "slab-roller", label: "Slab roller", w: 1.5, h: 0.75, tall: 0.9, group: "Pottery studio" },
  { key: "glaze-station", label: "Glaze buckets (6)", w: 1.0, h: 0.65, tall: 0.45, group: "Pottery studio" },
  { key: "ware-rack", label: "Drying / ware rack", w: 0.9, h: 0.5, tall: 1.8, group: "Pottery studio" },
  { key: "clay-sink", label: "Clay sink (with trap)", w: 0.7, h: 0.55, tall: 0.9, group: "Pottery studio" },
  { key: "pug-mill", label: "Pug mill", w: 1.0, h: 0.45, tall: 0.9, group: "Pottery studio" },
  { key: "spray-booth", label: "Glaze spray booth", w: 0.9, h: 0.65, tall: 1.6, group: "Pottery studio" },

  // Common sizes (width without mirrors × length). A garage door needs about 0.6 m more than the car's width.
  { key: "car-hatch", label: "Small hatch (Mazda2)", w: 1.7, h: 4.1, group: "Cars" },
  { key: "car-small", label: "Small car (Corolla)", w: 1.79, h: 4.4, group: "Cars" },
  { key: "car", label: "Car", w: 1.85, h: 4.8, group: "Cars" },
  { key: "car-cx30", label: "Small SUV (Mazda CX-30)", w: 1.8, h: 4.4, group: "Cars" },
  { key: "car-midsuv", label: "Mid SUV (RAV4)", w: 1.86, h: 4.6, group: "Cars" },
  { key: "suv", label: "Large SUV", w: 1.95, h: 5.0, group: "Cars" },
  { key: "people-mover", label: "People mover (Carnival)", w: 2.0, h: 5.16, group: "Cars" },
  { key: "ute", label: "Ute (HiLux / Ranger)", w: 1.9, h: 5.35, group: "Cars" },
  { key: "ute-large", label: "Full-size ute (RAM 1500)", w: 2.08, h: 5.92, group: "Cars" },
  { key: "van", label: "Van (HiAce LWB)", w: 1.95, h: 5.27, group: "Cars" },
  { key: "trailer", label: "Box trailer (7 × 5)", w: 1.6, h: 3.4, group: "Cars" },
  { key: "motorbike", label: "Motorbike", w: 0.8, h: 2.15, group: "Cars" },
  { key: "bicycle", label: "Bicycle", w: 0.6, h: 1.8, group: "Cars" },

  { key: "outdoor-table", label: "Outdoor table (6)", w: 1.8, h: 0.9, group: "Outside" },
  { key: "bbq", label: "BBQ", w: 1.4, h: 0.6, group: "Outside" },
  { key: "trampoline", label: "Trampoline", w: 3.0, h: 3.0, group: "Outside", round: true },

  // Bubu (the panda) and Dudu (the brown bear), sitting down, seen from above.
  { key: "panda", label: "Bubu (panda)", w: 0.9, h: 1.0, tall: 1.0, group: "Animals" },
  { key: "bear", label: "Dudu (bear)", w: 1.0, h: 1.1, tall: 1.1, group: "Animals" },

  // Plan symbols. A door is as deep as it is wide (its swing); the wall is along its bottom edge.
  { key: "door", label: "Door (820)", w: 0.82, h: 0.82, group: "Doors & windows" },
  { key: "door-wide", label: "Wide door (920)", w: 0.92, h: 0.92, group: "Doors & windows" },
  { key: "double-door", label: "Double doors", w: 1.64, h: 0.82, group: "Doors & windows" },
  { key: "sliding-door", label: "Sliding door", w: 2.1, h: 0.15, group: "Doors & windows" },
  { key: "window", label: "Window", w: 1.2, h: 0.15, group: "Doors & windows" },
  { key: "stairs", label: "Stairs", w: 1.0, h: 3.0, group: "Doors & windows" },
];

export const FURNITURE_BY_KEY = new Map(FURNITURE.map((f) => [f.key, f]));
export const GROUPS: Group[] = ["Custom", "Bedroom", "Living", "Dining", "Kitchen & laundry", "Fridges", "Bathroom", "Study", "Workshop",
  "3D printing & CNC", "Pottery studio", "Cars", "Outside", "Animals", "Doors & windows"];

/** Fill colour per room group, so a busy plan still reads at a glance. */
export const GROUP_COLOUR: Record<Group, string> = {
  Custom: "#6f8fa6",
  Bedroom: "#6d8fd6", Living: "#d98b5f", Dining: "#c9a24a", "Kitchen & laundry": "#5fa58f",
  Fridges: "#7d97a8", Bathroom: "#62a8c9", Study: "#9a7fc9", Workshop: "#b0814f", "3D printing & CNC": "#5f87b0",
  "Pottery studio": "#b86f58", Cars: "#7a8790", Outside: "#7f9a6d", Animals: "#8a6a4f", "Doors & windows": "#6f757a",
};
