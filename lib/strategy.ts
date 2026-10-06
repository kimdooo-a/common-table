// Turns the group's shared taste into a concrete plan shape.
// Each slot has several venue categories; the agent ranks them by how strongly the
// group's shared Qloo taste tags point at them, and keeps the rest as fallbacks for re-planning.

export type OutingType = "evening" | "day" | "date";

export interface CategoryOption {
  tag: string; // Qloo place category tag id
  label: string;
  cues: string[]; // words in taste-tag names that make this option a good fit
}

export interface SlotTemplate {
  key: string;
  title: string;
  options: CategoryOption[];
}

const C = (id: string, label: string, cues: string[] = []): CategoryOption => ({
  tag: `urn:tag:category:place:${id}`,
  label,
  cues,
});

const MUSIC = ["music", "rock", "indie", "jazz", "pop", "hip hop", "rap", "band", "album", "song", "punk", "electronic", "soul", "blues", "k-pop", "j-pop", "concert"];
const ART = ["art", "surreal", "artistic", "painting", "design", "architecture", "visual", "museum", "aesthetic", "avant", "experimental", "animation", "animated"];
const BOOK = ["literary", "novel", "book", "poetry", "writer", "fiction", "author", "reading", "classic"];
const STAGE = ["theater", "theatre", "drama", "musical", "stage", "comedy", "satire", "performance"];
const FILM = ["film", "movie", "cinema", "director", "cinematic", "anime"];
const COZY = ["cozy", "calm", "quiet", "gentle", "slice of life", "heartwarming", "melancholy", "nostalgic", "friendship"];
const NIGHT = ["party", "dance", "club", "nightlife", "edm", "energetic", "upbeat"];

export const TEMPLATES: Record<OutingType, SlotTemplate[]> = {
  evening: [
    {
      key: "warmup",
      title: "Early evening — something to do together",
      options: [C("art_gallery", "art gallery", ART), C("museum", "museum", [...ART, ...FILM]), C("book_store", "bookstore", BOOK), C("performing_arts_theater", "small theater", STAGE), C("park", "park", COZY)],
    },
    { key: "dinner", title: "Dinner", options: [C("restaurant", "restaurant")] },
    {
      key: "nightcap",
      title: "Nightcap",
      options: [C("jazz_club", "jazz / live music bar", MUSIC), C("live_music_venue", "live music venue", [...MUSIC, ...NIGHT]), C("cocktail_bar", "cocktail bar", NIGHT), C("wine_bar", "wine bar", COZY), C("bar", "bar")],
    },
  ],
  day: [
    { key: "coffee", title: "Morning coffee", options: [C("cafe", "cafe", COZY), C("bakery", "bakery", COZY), C("tea_house", "tea house", COZY)] },
    {
      key: "culture",
      title: "Late morning — culture",
      options: [C("museum", "museum", [...ART, ...FILM]), C("art_gallery", "art gallery", ART), C("book_store", "bookstore", BOOK), C("performing_arts_theater", "small theater", STAGE)],
    },
    { key: "lunch", title: "Lunch", options: [C("restaurant", "restaurant")] },
    { key: "wander", title: "Afternoon wander", options: [C("park", "park", COZY), C("book_store", "bookstore", BOOK), C("vintage_clothing_store", "vintage shop", [...ART, ...MUSIC]), C("tea_house", "tea house", COZY)] },
    { key: "dinner", title: "Dinner", options: [C("restaurant", "restaurant")] },
  ],
  date: [
    { key: "dinner", title: "Dinner", options: [C("restaurant", "restaurant")] },
    { key: "after", title: "After dinner", options: [C("jazz_club", "jazz / live music bar", MUSIC), C("cocktail_bar", "cocktail bar", NIGHT), C("wine_bar", "wine bar", COZY), C("performing_arts_theater", "small theater", STAGE), C("bar", "bar")] },
  ],
};

export interface RankedSlot {
  template: SlotTemplate;
  ranked: { option: CategoryOption; hits: string[] }[];
}

/** Rank each slot's category options by cue hits in the group's shared tag names. */
export function rankSlots(type: OutingType, sharedTagNames: string[]): RankedSlot[] {
  const names = sharedTagNames.map((n) => n.toLowerCase());
  return TEMPLATES[type].map((template) => {
    const ranked = template.options
      .map((option, i) => {
        const hits = option.cues.filter((cue) => names.some((n) => n.includes(cue)));
        return { option, hits, i };
      })
      // more hits first; ties keep the template's default order
      .sort((a, b) => b.hits.length - a.hits.length || a.i - b.i)
      .map(({ option, hits }) => ({ option, hits }));
    return { template, ranked };
  });
}
