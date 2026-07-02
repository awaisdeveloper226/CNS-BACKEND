// POST /api/distance/driving
// Body: { origin: {lat,lng}, destinations: [{id,lat,lng}, ...] }  (max 25 destinations/request)
exports.getDrivingDistances = async (req, res) => {
  const { origin, destinations } = req.body;
  if (!origin || !Array.isArray(destinations) || destinations.length === 0) {
    return res.json({ distances: {} });
  }

  const batch = destinations.slice(0, 25);

  const body = {
    origins: [
      { waypoint: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } } },
    ],
    destinations: batch.map((d) => ({
      waypoint: { location: { latLng: { latitude: d.lat, longitude: d.lng } } },
    })),
    travelMode: "DRIVE",
  };

  try {
    const resp = await fetch(
      "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": process.env.GOOGLE_PLACES_API_KEY,
          // Field mask is REQUIRED by Routes API — omit it and every field comes back empty.
          "X-Goog-FieldMask":
            "originIndex,destinationIndex,distanceMeters,duration,condition,status",
        },
        body: JSON.stringify(body),
      },
    );

    const rows = await resp.json(); // returns an array of RouteMatrixElement objects
    const distances = {};

    if (Array.isArray(rows)) {
      for (const el of rows) {
        // originIndex is always 0 here since we only send one origin
        if (el?.condition === "ROUTE_EXISTS" && typeof el.distanceMeters === "number") {
          const dest = batch[el.destinationIndex];
          if (dest) {
            distances[dest.id] = Math.round((el.distanceMeters / 1000) * 10) / 10;
          }
        }
      }
    }

    res.json({ distances });
  } catch {
    res.json({ distances: {} }); // fail silent — frontend keeps Haversine as fallback
  }
};
