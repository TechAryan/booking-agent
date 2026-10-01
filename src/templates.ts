// Quick-start business types for the Business details step. Picking one only pre-fills the form.
// `extra` is suggested text for "Extra information" (used only if that box is empty) so the
// assistant knows what a "booking" means for this kind of business.

export interface Template {
  key: string;
  cat: string;
  emoji: string;
  label: string;
  services: string;
  open: number;
  close: number;
  slot: number;
  days: number[];
  extra?: string;
  tags?: string; // extra search words
  popular?: boolean;
  mode?: "online" | "offline" | "both";
}

/** Usual way each kind of business meets customers (a template can override it). */
export const CAT_MODE: Record<string, "online" | "offline" | "both"> = {
  creators: "online", pros: "both", shops: "offline", health: "offline", beauty: "offline", fitness: "offline", education: "both", home: "offline", events: "offline", auto: "offline",
};

export const CATEGORIES: [string, string][] = [
  ["popular", "Popular"],
  ["creators", "Creators"],
  ["pros", "Professionals"],
  ["shops", "Shops & retail"],
  ["health", "Health"],
  ["beauty", "Beauty & wellness"],
  ["fitness", "Fitness & sports"],
  ["education", "Education"],
  ["home", "Home & repairs"],
  ["events", "Events & food"],
  ["auto", "Auto & travel"],
];

const WEEK = [1, 2, 3, 4, 5, 6];
const ALL = [1, 2, 3, 4, 5, 6, 7];
const MF = [1, 2, 3, 4, 5];

export const TEMPLATES: Template[] = [
  // Creators & influencers
  { key: "influencer", cat: "creators", emoji: "🤳", label: "Influencer / creator", popular: true, tags: "instagram youtube brand collab collaboration",
    services: "Brand collaboration call, Paid promotion discussion, Shoutout / story booking, Fan video call, Meet and greet", open: 11, close: 20, slot: 30, days: ALL,
    extra: "Brands and fans book a call with me here. For paid promotions, ask for the brand name, product and budget before booking. Share my rate card only if I've written it below." },
  { key: "podcaster", cat: "creators", emoji: "🎙️", label: "Podcaster", tags: "podcast guest interview",
    services: "Guest interview slot, Pre-interview call, Sponsor discussion", open: 10, close: 19, slot: 60, days: MF },
  { key: "photographer", mode: "offline", cat: "creators", emoji: "📸", label: "Photographer / videographer", popular: true, tags: "photo shoot video wedding",
    services: "Portrait shoot, Product shoot, Event coverage enquiry, Pre-wedding shoot consultation, Editing call", open: 9, close: 20, slot: 60, days: ALL },
  { key: "artist", cat: "creators", emoji: "🎨", label: "Artist / designer", tags: "graphic design logo illustration tattoo",
    services: "Design consultation, Logo discussion, Commission enquiry, Review call", open: 11, close: 19, slot: 30, days: WEEK },
  { key: "musician", mode: "offline", cat: "creators", emoji: "🎸", label: "Musician / DJ", tags: "singer band dj live performance",
    services: "Event booking enquiry, Music lesson, Studio session", open: 11, close: 21, slot: 60, days: ALL },

  // Professionals & freelancers
  { key: "consultant", cat: "pros", emoji: "💼", label: "Consultant", popular: true, tags: "business advisor strategy",
    services: "Free discovery call, Consultation (paid), Follow-up session, Strategy workshop", open: 10, close: 19, slot: 30, days: MF,
    extra: "The first discovery call is free for 15 minutes. Ask the customer what they need help with before booking." },
  { key: "software", mode: "online", cat: "pros", emoji: "👨‍💻", label: "Software developer", popular: true, tags: "engineer freelancer app website developer it tech",
    services: "Project discussion call, Website / app quote, Technical consultation, Code review session, Support call", open: 10, close: 19, slot: 30, days: MF,
    extra: "Ask what they want built (website, app, fix) and their timeline before booking the call." },
  { key: "marketing", mode: "online", cat: "pros", emoji: "📈", label: "Digital marketing expert", popular: true, tags: "seo ads social media marketing agency",
    services: "Free marketing audit call, SEO consultation, Social media strategy, Ads account review, Monthly review meeting", open: 10, close: 19, slot: 30, days: WEEK },
  { key: "ca", mode: "both", cat: "pros", emoji: "🧾", label: "CA / tax consultant", tags: "chartered accountant gst itr tax filing accountant",
    services: "Income tax filing, GST registration / filing, Business registration, Accounting consultation", open: 10, close: 18, slot: 30, days: WEEK },
  { key: "lawyer", cat: "pros", emoji: "⚖️", label: "Lawyer / legal advisor", tags: "advocate legal",
    services: "Legal consultation, Document review, Property matter, Family matter", open: 10, close: 18, slot: 30, days: WEEK,
    extra: "Don't give legal advice in chat. Book a consultation instead." },
  { key: "coach", cat: "pros", emoji: "🧭", label: "Life / career coach", tags: "mentor coaching career",
    services: "Intro call, Coaching session, Career guidance, Resume review", open: 9, close: 21, slot: 45, days: ALL },
  { key: "realestate", mode: "offline", cat: "pros", emoji: "🏠", label: "Real estate agent", tags: "property broker flat rent sale",
    services: "Property visit, Rental enquiry, Buying consultation, Selling consultation", open: 10, close: 19, slot: 45, days: ALL },
  { key: "insurance", cat: "pros", emoji: "🛡️", label: "Insurance / finance advisor", tags: "mutual fund loan financial planner",
    services: "Policy consultation, Claim help, Investment planning call, Loan enquiry", open: 10, close: 19, slot: 30, days: WEEK },

  // Shops & retail
  { key: "kirana", cat: "shops", emoji: "🛒", label: "Kirana / grocery store", popular: true, tags: "grocery general store supermarket provision",
    services: "Order pickup slot, Home delivery slot, Bulk order enquiry", open: 8, close: 21, slot: 30, days: ALL,
    extra: "Customers book a time to pick up their order or get it delivered. Ask for the list of items and their address for delivery. Don't promise prices or stock, the shop will confirm." },
  { key: "boutique", cat: "shops", emoji: "👗", label: "Boutique / tailor", tags: "clothes fashion stitching tailoring alteration",
    services: "Measurement appointment, Trial fitting, Alteration drop-off, Custom outfit consultation", open: 11, close: 20, slot: 30, days: WEEK },
  { key: "mobile", cat: "shops", emoji: "📱", label: "Mobile / electronics shop", tags: "phone repair laptop computer",
    services: "Phone repair drop-off, Screen replacement, Laptop service, New phone demo", open: 10, close: 21, slot: 30, days: ALL },
  { key: "bakery", cat: "shops", emoji: "🎂", label: "Bakery / cake shop", tags: "cake cafe sweets order",
    services: "Custom cake order, Cake pickup slot, Party order enquiry", open: 9, close: 21, slot: 30, days: ALL,
    extra: "For custom cakes ask for the date, weight, flavour and message on the cake. Pickup slots must be at least 1 day after ordering." },
  { key: "pharmacy", cat: "shops", emoji: "💊", label: "Pharmacy / medical store", tags: "chemist medicine",
    services: "Medicine order pickup, Home delivery slot, Prescription check", open: 8, close: 22, slot: 30, days: ALL,
    extra: "Don't give medical advice. Only book pickup or delivery times." },
  { key: "optician", cat: "shops", emoji: "👓", label: "Optician", tags: "eye glasses spectacles",
    services: "Eye test, Frame selection, Lens fitting, Contact lens trial", open: 10, close: 20, slot: 30, days: WEEK },
  { key: "jeweller", cat: "shops", emoji: "💍", label: "Jeweller", tags: "gold jewellery jewelry",
    services: "Showroom visit, Custom design consultation, Repair / polish", open: 11, close: 20, slot: 45, days: WEEK },
  { key: "furniture", cat: "shops", emoji: "🛋️", label: "Furniture / home decor", tags: "interior decor",
    services: "Showroom visit, Custom furniture consultation, Measurement visit", open: 10, close: 20, slot: 60, days: ALL },

  // Health
  { key: "dental", cat: "health", emoji: "🦷", label: "Dental clinic", popular: true, tags: "dentist teeth",
    services: "Consultation, Dental cleaning, Tooth filling, Root canal consultation, Teeth whitening", open: 10, close: 19, slot: 30, days: WEEK,
    extra: "Don't give medical advice." },
  { key: "doctor", cat: "health", emoji: "🩺", label: "Doctor / clinic", popular: true, tags: "physician hospital gp",
    services: "General consultation, Follow-up visit, Health check-up, Vaccination", open: 9, close: 18, slot: 15, days: WEEK,
    extra: "Don't give medical advice. For emergencies, tell the customer to call the clinic or go to the nearest hospital." },
  { key: "physio", cat: "health", emoji: "🦴", label: "Physiotherapist", tags: "physio therapy",
    services: "Assessment, Physiotherapy session, Home visit, Follow-up", open: 8, close: 20, slot: 45, days: WEEK },
  { key: "therapist", mode: "both", cat: "health", emoji: "🧠", label: "Therapist / counsellor", tags: "psychologist counselling mental health",
    services: "First session, Therapy session (online), Therapy session (in person), Couples session", open: 10, close: 20, slot: 60, days: WEEK,
    extra: "Keep replies gentle and private. If someone says they are in danger, share the local emergency number and ask them to reach out to someone right away." },
  { key: "dietitian", mode: "both", cat: "health", emoji: "🥗", label: "Dietitian / nutritionist", tags: "diet nutrition weight loss",
    services: "First consultation, Diet plan review, Weekly follow-up", open: 9, close: 19, slot: 30, days: WEEK },
  { key: "vet", cat: "health", emoji: "🐾", label: "Vet / pet care", tags: "veterinary pet grooming dog cat",
    services: "Vet consultation, Vaccination, Pet grooming, Pet boarding enquiry", open: 9, close: 20, slot: 30, days: ALL },

  // Beauty & wellness
  { key: "salon", cat: "beauty", emoji: "💇", label: "Salon", popular: true, tags: "hair barber parlour parlor",
    services: "Haircut, Hair colour, Blow-dry, Beard trim, Facial, Manicure", open: 10, close: 20, slot: 45, days: ALL },
  { key: "makeup", cat: "beauty", emoji: "💄", label: "Makeup artist", tags: "bridal mua makeup",
    services: "Bridal makeup consultation, Party makeup, Makeup trial, Hairstyling", open: 8, close: 20, slot: 60, days: ALL },
  { key: "mehendi", cat: "beauty", emoji: "🌿", label: "Mehendi artist", tags: "henna mehndi bridal",
    services: "Bridal mehendi booking, Party mehendi, Design consultation", open: 9, close: 21, slot: 60, days: ALL },
  { key: "spa", cat: "beauty", emoji: "💆", label: "Spa & massage", tags: "massage wellness",
    services: "Swedish massage, Deep tissue massage, Aromatherapy, Body scrub", open: 10, close: 21, slot: 60, days: ALL },
  { key: "nails", cat: "beauty", emoji: "💅", label: "Nail studio", tags: "nails manicure pedicure",
    services: "Manicure, Pedicure, Gel nails, Nail art, Nail extensions", open: 11, close: 20, slot: 45, days: ALL },
  { key: "skin", cat: "beauty", emoji: "✨", label: "Skin clinic", tags: "dermatologist skin care laser",
    services: "Skin consultation, Facial treatment, Laser hair removal, Follow-up", open: 10, close: 19, slot: 30, days: WEEK },

  // Fitness & sports
  { key: "fitness", cat: "fitness", emoji: "🏋️", label: "Personal trainer", popular: true, tags: "gym fitness trainer",
    services: "Personal training, Assessment session, Online training, Diet consultation", open: 6, close: 21, slot: 60, days: WEEK },
  { key: "gym", cat: "fitness", emoji: "💪", label: "Gym", tags: "gym membership",
    services: "Free trial workout, Membership enquiry, Personal trainer session, Body assessment", open: 6, close: 22, slot: 60, days: ALL },
  { key: "yoga", cat: "fitness", emoji: "🧘", label: "Yoga / meditation", tags: "yoga meditation pilates",
    services: "Trial class, Group class, Private session, Online class", open: 6, close: 20, slot: 60, days: ALL },
  { key: "dance", cat: "fitness", emoji: "💃", label: "Dance studio", tags: "dance zumba",
    services: "Trial class, Regular class, Wedding choreography, Private lesson", open: 7, close: 21, slot: 60, days: ALL },
  { key: "sports", cat: "fitness", emoji: "🏸", label: "Sports court / turf", tags: "badminton football turf cricket box court booking",
    services: "Court booking, Turf booking, Coaching session", open: 6, close: 23, slot: 60, days: ALL,
    extra: "Customers book the court or turf by the hour. Ask how many players and which sport." },

  // Education
  { key: "tutor", cat: "education", emoji: "📚", label: "Tutor", popular: true, tags: "tuition teacher classes",
    services: "Trial class, Maths session, Science session, Exam preparation", open: 15, close: 21, slot: 60, days: WEEK },
  { key: "coaching", cat: "education", emoji: "🏫", label: "Coaching institute", tags: "institute classes jee neet upsc",
    services: "Counselling session, Demo class, Admission enquiry, Parent meeting", open: 9, close: 19, slot: 30, days: WEEK },
  { key: "music-teacher", cat: "education", emoji: "🎹", label: "Music teacher", tags: "guitar piano singing lessons",
    services: "Trial lesson, Guitar lesson, Keyboard lesson, Vocal lesson", open: 10, close: 21, slot: 60, days: ALL },
  { key: "language", mode: "both", cat: "education", emoji: "🗣️", label: "Language / spoken English", tags: "english ielts language class",
    services: "Level test, Trial class, Spoken English class, IELTS preparation", open: 8, close: 21, slot: 60, days: WEEK },
  { key: "driving", mode: "offline", cat: "education", emoji: "🚗", label: "Driving school", tags: "driving lessons licence",
    services: "Trial lesson, Driving lesson, Licence test preparation", open: 6, close: 19, slot: 60, days: ALL },

  // Home & repairs
  { key: "repair", cat: "home", emoji: "🔧", label: "Home repair / handyman", tags: "plumber electrician carpenter",
    services: "Plumbing visit, Electrical repair, Carpentry work, General repair", open: 9, close: 19, slot: 60, days: ALL,
    extra: "Ask for the address and a short description of the problem before booking a visit." },
  { key: "ac", cat: "home", emoji: "❄️", label: "AC / appliance service", tags: "ac washing machine fridge appliance",
    services: "AC service, AC repair, Washing machine repair, Fridge repair, Installation", open: 9, close: 20, slot: 60, days: ALL },
  { key: "cleaning", cat: "home", emoji: "🧹", label: "Cleaning service", tags: "deep cleaning pest control housekeeping",
    services: "Home deep cleaning, Bathroom cleaning, Sofa cleaning, Pest control", open: 8, close: 19, slot: 120, days: ALL },
  { key: "interior", cat: "home", emoji: "📐", label: "Interior designer / architect", tags: "interior architect design",
    services: "Site visit, Design consultation, Quote discussion", open: 10, close: 19, slot: 60, days: WEEK },

  // Events & food
  { key: "restaurant", cat: "events", emoji: "🍽️", label: "Restaurant / cafe", popular: true, tags: "table reservation cafe dining",
    services: "Table reservation, Private dining, Birthday party booking", open: 12, close: 23, slot: 30, days: ALL,
    extra: "Ask how many people and whether they need a high chair or any special arrangement." },
  { key: "caterer", cat: "events", emoji: "🍱", label: "Caterer / home chef", tags: "tiffin catering home food",
    services: "Menu tasting, Event catering enquiry, Tiffin subscription call", open: 10, close: 20, slot: 30, days: ALL },
  { key: "events", cat: "events", emoji: "🎉", label: "Event planner / decorator", tags: "wedding planner decoration birthday",
    services: "Event consultation, Venue visit, Decoration discussion, Wedding planning call", open: 10, close: 20, slot: 60, days: ALL },
  { key: "venue", cat: "events", emoji: "🏛️", label: "Banquet / venue", tags: "hall banquet party venue",
    services: "Venue visit, Booking enquiry, Menu discussion", open: 10, close: 20, slot: 60, days: ALL },

  // Auto & travel
  { key: "garage", cat: "auto", emoji: "🛠️", label: "Car / bike service", tags: "garage mechanic car wash bike",
    services: "General service, Repair inspection, Car wash, Pickup and drop", open: 9, close: 19, slot: 60, days: WEEK },
  { key: "travel", mode: "both", cat: "auto", emoji: "✈️", label: "Travel agent", tags: "tour holiday visa tickets",
    services: "Holiday planning call, Visa consultation, Ticket booking help", open: 10, close: 19, slot: 30, days: WEEK },
  { key: "homestay", cat: "auto", emoji: "🏡", label: "Homestay / hotel", tags: "hotel stay room",
    services: "Room enquiry call, Property visit, Group booking enquiry", open: 9, close: 21, slot: 30, days: ALL },
];
