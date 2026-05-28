const swaggerJsdoc = require('swagger-jsdoc');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Carribu - School Transport API',
      version: '2.0.0',
      description: 'REST API for managing school transportation — vehicles, routes, trips, real-time tracking, and messaging between drivers and parents.',
      contact: {
        name: 'Carribu Team',
        url: 'https://github.com/Ahmedsebit/carribu_backend',
      },
      license: {
        name: 'ISC',
      },
    },
    servers: [
      {
        url: 'http://localhost:5000',
        description: 'Local development',
      },
    ],
    components: {
      securitySchemes: {
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
      schemas: {
        School: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            name: { type: 'string', example: 'Nairobi Academy' },
            address: { type: 'string', example: '123 Ngong Road' },
            city: { type: 'string', example: 'Nairobi' },
            phone: { type: 'string', example: '+254700111222' },
            email: { type: 'string', format: 'email', example: 'admin@nairobiacademy.co.ke' },
            logoUrl: { type: 'string', nullable: true },
            isActive: { type: 'boolean', default: true },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        User: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            schoolId: { type: 'integer' },
            email: { type: 'string', format: 'email' },
            firstName: { type: 'string', example: 'Alice' },
            lastName: { type: 'string', example: 'Mwangi' },
            role: { type: 'string', enum: ['super_admin', 'admin', 'coordinator', 'driver', 'parent'] },
            phone: { type: 'string', example: '+254711000001' },
            pickupAddress: { type: 'string', nullable: true },
            pickupLat: { type: 'number', format: 'double', nullable: true },
            pickupLng: { type: 'number', format: 'double', nullable: true },
            isActive: { type: 'boolean', default: true },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        Vehicle: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            schoolId: { type: 'integer' },
            plateNumber: { type: 'string', example: 'KDA 001A' },
            make: { type: 'string', example: 'Toyota' },
            model: { type: 'string', example: 'HiAce' },
            year: { type: 'integer', example: 2022 },
            capacity: { type: 'integer', example: 18 },
            color: { type: 'string', example: 'White' },
            status: { type: 'string', enum: ['active', 'maintenance', 'retired'] },
            insuranceExpiry: { type: 'string', format: 'date' },
            lastServiceDate: { type: 'string', format: 'date', nullable: true },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        Student: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            schoolId: { type: 'integer' },
            parentId: { type: 'integer', nullable: true },
            firstName: { type: 'string', example: 'Child' },
            lastName: { type: 'string', example: 'One' },
            grade: { type: 'string', example: 'Grade 3' },
            isActive: { type: 'boolean', default: true },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        Route: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            schoolId: { type: 'integer' },
            name: { type: 'string', example: 'Westlands Route' },
            description: { type: 'string' },
            vehicleId: { type: 'integer', nullable: true },
            driverId: { type: 'integer', nullable: true },
            type: { type: 'string', enum: ['morning', 'afternoon', 'both'] },
            grades: { type: 'array', items: { type: 'string' } },
            departureTime: { type: 'string', example: '07:00' },
            waypoints: { type: 'array', items: { type: 'object' } },
            isActive: { type: 'boolean', default: true },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        Trip: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            routeId: { type: 'integer' },
            driverId: { type: 'integer' },
            vehicleId: { type: 'integer' },
            status: { type: 'string', enum: ['scheduled', 'in_progress', 'completed', 'cancelled'] },
            type: { type: 'string', enum: ['morning_pickup', 'afternoon_dropoff'] },
            scheduledDate: { type: 'string', format: 'date' },
            startedAt: { type: 'string', format: 'date-time', nullable: true },
            endedAt: { type: 'string', format: 'date-time', nullable: true },
            notes: { type: 'string', nullable: true },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        Message: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            schoolId: { type: 'integer' },
            senderId: { type: 'integer' },
            receiverId: { type: 'integer' },
            tripId: { type: 'integer', nullable: true },
            content: { type: 'string' },
            type: { type: 'string' },
            isRead: { type: 'boolean' },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },
        Error: {
          type: 'object',
          properties: {
            error: { type: 'string' },
            details: { type: 'string' },
          },
        },
      },
    },
    security: [{ BearerAuth: [] }],
  },
  apis: ['./routes/*.js'],
};

const swaggerSpec = swaggerJsdoc(options);

module.exports = swaggerSpec;
