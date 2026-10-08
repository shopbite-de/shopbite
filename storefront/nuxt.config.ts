// Your shop on top of the ShopBite storefront (a Nuxt layer). Everything the layer
// ships can be overridden here: texts in content/, style preset and colours below,
// logo and images in public/, components with the same name in app/components/.
// Docs: https://shopbite.de/docs/storefront/first-steps
export default defineNuxtConfig({
  extends: ["@shopbite-de/storefront"],

  compatibilityDate: "2025-07-15",

  css: ["~/assets/css/main.css"],

  // Look of the shop: "trattoria" (Italian, light), "grill" (Turkish, dark) or "asia"
  // (light). `colors` overrides single tokens, e.g. the button colour; the build warns
  // when an override misses the WCAG AA contrast.
  shopBite: {
    preset: "trattoria",
    // colors: { primary: "#3F7D20" },
  },

  runtimeConfig: {
    public: {
      shopBite: {
        feature: {
          // contact page /kontakt (linked in the header and footer); messages go to the
          // shop e-mail address in Shopware, locally to Mailpit
          contactForm: true,
        },
      },
      site: {
        name: "ShopBite Demo",
        // footer contact block and search engine data, empty values are hidden
        address: {
          street: "Musterstraße 1",
          postalCode: "12345",
          city: "Musterstadt",
        },
        telephone: "+49 123 456789",
      },
    },
  },
});
