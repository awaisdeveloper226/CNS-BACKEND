// backend/config/db.js

const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    // Connect using the URI defined in backend/.env
    const conn = await mongoose.connect(process.env.MONGO_URI);

    console.log(`MongoDB Connected: ${conn.connection.host}`);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    // Exit process with failure
    process.exit(1);
  }
};

module.exports = connectDB;