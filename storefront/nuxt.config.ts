// Your shop on top of the ShopBite storefront (a Nuxt layer). Everything the layer
// ships can be overridden here: texts in content/, colours in app/assets/css/main.css,
// logo and images in public/, components with the same name in app/components/.
// Docs: https://shopbite.de/docs/storefront/first-steps
export default defineNuxtConfig({
  extends: ["@shopbite-de/storefront"],

  compatibilityDate: "2025-07-15",

  css: ["~/assets/css/main.css"],

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
