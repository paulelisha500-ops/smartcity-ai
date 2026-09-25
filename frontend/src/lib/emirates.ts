/**
 * The seven emirates, with the photography used across the public pages.
 *
 * Every image is from Wikimedia Commons under a licence that permits reuse
 * with attribution (CC BY / CC BY-SA). The photographer and licence are
 * carried here rather than buried in a build script, because attribution is a
 * condition of the licence — if an image is swapped, its credit must be
 * swapped with it. Files live in `public/emirates/` and are served locally, so
 * the pages do not hotlink Commons.
 */
export interface Emirate {
  slug: string;
  name: string;
  code: string;
  note: string;
  image: string;
  alt: string;
  credit: { photographer: string; license: string; source: string };
}

export const EMIRATES: Emirate[] = [
  {
    slug: "dubai",
    name: "Dubai",
    code: "E11 · E311 · E611",
    note: "Densest modelled network — Sheikh Zayed Road, Al Khail and the Emirates Road corridor.",
    image: "/emirates/dubai.jpg",
    alt: "Burj Khalifa and the Dubai skyline",
    credit: {
      photographer: "imran shahabuddin",
      license: "CC BY 2.0",
      source: "https://commons.wikimedia.org/wiki/File:Burj_Khalifa_(worlds_tallest_building)_and_the_Dubai_skyline_(25781049892).jpg",
    },
  },
  {
    slug: "abu-dhabi",
    name: "Abu Dhabi",
    code: "E10 · E11 · E20",
    note: "Largest emirate by area; carries the E11 west to the Saudi crossing at Al Ghuwaifat.",
    image: "/emirates/abu-dhabi.jpg",
    alt: "Abu Dhabi city",
    credit: {
      photographer: "Adilamin786",
      license: "CC BY-SA 4.0",
      source: "https://commons.wikimedia.org/wiki/File:Abu_Dhabi_city.jpg",
    },
  },
  {
    slug: "sharjah",
    name: "Sharjah",
    code: "E11 · E88 · E102",
    note: "The heaviest cross-emirate commute in the country runs through here each morning.",
    image: "/emirates/sharjah.jpg",
    alt: "Sharjah corniche at night",
    credit: {
      photographer: "NikithaSuresh 26",
      license: "CC BY-SA 4.0",
      source: "https://commons.wikimedia.org/wiki/File:A_night_at_the_corniche.jpg",
    },
  },
  {
    slug: "ajman",
    name: "Ajman",
    code: "E11",
    note: "Smallest emirate; its corniche corridor feeds directly onto the E11.",
    image: "/emirates/ajman.jpg",
    alt: "A ship on the Ajman coast",
    credit: {
      photographer: "SHARON VISHAKHAM",
      license: "CC BY-SA 4.0",
      source: "https://commons.wikimedia.org/wiki/File:A_Ship_in_Ajman_Coast.jpg",
    },
  },
  {
    slug: "umm-al-quwain",
    name: "Umm Al Quwain",
    code: "E11 · E55",
    note: "Coastal lagoon emirate between Ajman and Ras Al Khaimah.",
    image: "/emirates/umm-al-quwain.jpg",
    alt: "Sunset over Umm Al Quwain beach",
    credit: {
      photographer: "Anamsajid2013",
      license: "CC BY-SA 4.0",
      source: "https://commons.wikimedia.org/wiki/File:Sunset_view_in_Umm_Al_Quwain_Beach.jpg",
    },
  },
  {
    slug: "ras-al-khaimah",
    name: "Ras Al Khaimah",
    code: "E11 · E18",
    note: "Northern terminus of the E11 and the Al Darah crossing into Omani Musandam.",
    image: "/emirates/ras-al-khaimah.jpg",
    alt: "Aerial view over Ras Al Khaimah",
    credit: {
      photographer: "Snapshotdxb",
      license: "CC BY-SA 3.0",
      source: "https://commons.wikimedia.org/wiki/File:Aerial_photography_over_RAK._-_panoramio_(1).jpg",
    },
  },
  {
    slug: "fujairah",
    name: "Fujairah",
    code: "E99 · E89",
    note: "The only emirate on the Gulf of Oman; Khatmat Malaha crossing sits on its approach.",
    image: "/emirates/fujairah.jpg",
    alt: "Al Bithnah Fort, Fujairah",
    credit: {
      photographer: 'Mike "fasmike" Che',
      license: "CC BY-SA 3.0",
      source: "https://commons.wikimedia.org/wiki/File:Al_Bithnah_Fort,_Fujairah,_UAE.jpg",
    },
  },
];

export const CREDIT_NOTE =
  "Photography from Wikimedia Commons under CC BY / CC BY-SA licences — " +
  EMIRATES.map((e) => `${e.name}: ${e.credit.photographer} (${e.credit.license})`).join(" · ") +
  ".";
