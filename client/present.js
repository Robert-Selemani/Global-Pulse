/* global GP */
'use strict';

// Presentation page: a public, read-only live map for display on screens.
GP.initMap();
GP.boot()
  .then(() => GP.startPolling())
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Failed to load presentation:', err);
  });
