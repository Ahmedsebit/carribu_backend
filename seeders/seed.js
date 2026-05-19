require('dotenv').config();
const { sequelize, School, User, Vehicle, Student, Route, RouteStudent, Trip, TripLog } = require('../models');
(async () => {
  try {
    await sequelize.authenticate();
    await sequelize.sync({ force: true });
    console.log('✅ Tables recreated.');
    const schools = await School.bulkCreate([
      { name: 'Nairobi Academy', address: '123 Ngong Road', city: 'Nairobi', phone: '+254700111222', email: 'admin@nairobiacademy.co.ke' },
      { name: 'Mombasa International School', address: '45 Links Road', city: 'Mombasa', phone: '+254700333444', email: 'admin@mombasainternational.co.ke' },
      { name: 'Kisumu Lakeside School', address: '78 Oginga Odinga St', city: 'Kisumu', phone: '+254700555666', email: 'admin@kisumulakeside.co.ke' },
    ]);
    console.log(`✅ ${schools.length} schools`);
    const users = await User.bulkCreate([
      { schoolId:1, email:'admin@nairobiacademy.co.ke', passwordHash:'admin123', firstName:'Alice', lastName:'Mwangi', role:'admin', phone:'+254711000001' },
      { schoolId:1, email:'coordinator@nairobiacademy.co.ke', passwordHash:'coord123', firstName:'Brian', lastName:'Ochieng', role:'coordinator', phone:'+254711000002' },
      { schoolId:1, email:'driver1@nairobiacademy.co.ke', passwordHash:'driver123', firstName:'Charles', lastName:'Mutua', role:'driver', phone:'+254711000003' },
      { schoolId:1, email:'driver2@nairobiacademy.co.ke', passwordHash:'driver123', firstName:'David', lastName:'Wanjiru', role:'driver', phone:'+254711000004' },
      { schoolId:1, email:'parent1@gmail.com', passwordHash:'parent123', firstName:'Esther', lastName:'Kamau', role:'parent', phone:'+254711000005' },
      { schoolId:1, email:'parent2@gmail.com', passwordHash:'parent123', firstName:'Francis', lastName:'Njoroge', role:'parent', phone:'+254711000006' },
      { schoolId:1, email:'parent3@gmail.com', passwordHash:'parent123', firstName:'Grace', lastName:'Otieno', role:'parent', phone:'+254711000007' },
      { schoolId:2, email:'admin@mombasainternational.co.ke', passwordHash:'admin123', firstName:'Hassan', lastName:'Ahmed', role:'admin', phone:'+254711000008' },
      { schoolId:2, email:'driver1@mombasainternational.co.ke', passwordHash:'driver123', firstName:'Ibrahim', lastName:'Said', role:'driver', phone:'+254711000009' },
      { schoolId:2, email:'parent4@gmail.com', passwordHash:'parent123', firstName:'Jamila', lastName:'Omar', role:'parent', phone:'+254711000010' },
      { schoolId:3, email:'admin@kisumulakeside.co.ke', passwordHash:'admin123', firstName:'Kevin', lastName:'Onyango', role:'admin', phone:'+254711000011' },
      { schoolId:3, email:'driver1@kisumulakeside.co.ke', passwordHash:'driver123', firstName:'Lilian', lastName:'Auma', role:'driver', phone:'+254711000012' },
    ], { individualHooks: true });
    console.log(`✅ ${users.length} users (passwords hashed)`);
    const vehicles = await Vehicle.bulkCreate([
      { schoolId:1, plateNumber:'KDA 001A', make:'Toyota', model:'HiAce', year:2022, capacity:18, color:'White', status:'active', insuranceExpiry:'2027-03-15' },
      { schoolId:1, plateNumber:'KDA 002B', make:'Isuzu', model:'NQR', year:2021, capacity:33, color:'Yellow', status:'active', insuranceExpiry:'2027-06-20' },
      { schoolId:1, plateNumber:'KDA 003C', make:'Toyota', model:'Coaster', year:2023, capacity:29, color:'Blue', status:'active', insuranceExpiry:'2027-09-01' },
      { schoolId:1, plateNumber:'KDA 004D', make:'Nissan', model:'Civilian', year:2019, capacity:25, color:'White', status:'maintenance', insuranceExpiry:'2026-12-31' },
      { schoolId:2, plateNumber:'KCA 010X', make:'Toyota', model:'Coaster', year:2023, capacity:29, color:'Green', status:'active', insuranceExpiry:'2027-05-15' },
      { schoolId:2, plateNumber:'KCA 011Y', make:'Isuzu', model:'FRR', year:2022, capacity:40, color:'Orange', status:'active', insuranceExpiry:'2027-08-30' },
      { schoolId:3, plateNumber:'KBZ 020M', make:'Toyota', model:'HiAce', year:2021, capacity:18, color:'Silver', status:'active', insuranceExpiry:'2027-04-10' },
      { schoolId:3, plateNumber:'KBZ 021N', make:'Mitsubishi', model:'Rosa', year:2020, capacity:28, color:'White', status:'active', insuranceExpiry:'2027-01-25' },
    ]);
    console.log(`✅ ${vehicles.length} vehicles`);
    const students = await Student.bulkCreate([
      { schoolId:1, parentId:5, firstName:'Amani', lastName:'Kamau', grade:'Grade 3', pickupAddress:'Westlands, Nairobi', pickupLat:-1.2641, pickupLng:36.8053 },
      { schoolId:1, parentId:5, firstName:'Baraka', lastName:'Kamau', grade:'Grade 5', pickupAddress:'Westlands, Nairobi', pickupLat:-1.2641, pickupLng:36.8053 },
      { schoolId:1, parentId:6, firstName:'Ciku', lastName:'Njoroge', grade:'Grade 2', pickupAddress:'Kilimani, Nairobi', pickupLat:-1.2888, pickupLng:36.7845 },
      { schoolId:1, parentId:6, firstName:'Diani', lastName:'Njoroge', grade:'Grade 4', pickupAddress:'Kilimani, Nairobi', pickupLat:-1.2888, pickupLng:36.7845 },
      { schoolId:1, parentId:7, firstName:'Erick', lastName:'Otieno', grade:'Grade 1', pickupAddress:'South B, Nairobi', pickupLat:-1.3092, pickupLng:36.8345 },
      { schoolId:1, parentId:7, firstName:'Faith', lastName:'Otieno', grade:'Grade 6', pickupAddress:'South B, Nairobi', pickupLat:-1.3092, pickupLng:36.8345 },
      { schoolId:2, parentId:10, firstName:'Ghali', lastName:'Omar', grade:'Grade 3', pickupAddress:'Nyali, Mombasa', pickupLat:-4.0225, pickupLng:39.7103 },
      { schoolId:2, parentId:10, firstName:'Halima', lastName:'Omar', grade:'Grade 5', pickupAddress:'Nyali, Mombasa', pickupLat:-4.0225, pickupLng:39.7103 },
      { schoolId:3, firstName:'Ian', lastName:'Odhiambo', grade:'Grade 2', pickupAddress:'Milimani, Kisumu', pickupLat:-0.0917, pickupLng:34.7680 },
      { schoolId:3, firstName:'Joyce', lastName:'Adhiambo', grade:'Grade 4', pickupAddress:'Tom Mboya, Kisumu', pickupLat:-0.1022, pickupLng:34.7517 },
    ]);
    console.log(`✅ ${students.length} students`);
    await Route.bulkCreate([
      { schoolId:1, name:'Westlands–Kilimani Route', description:'Covers Westlands and Kilimani', vehicleId:1, driverId:3, type:'both' },
      { schoolId:1, name:'South B–South C Route', description:'Covers South B and South C', vehicleId:2, driverId:4, type:'both' },
      { schoolId:1, name:'Karen–Langata Route', description:'Covers Karen and Langata', vehicleId:3, driverId:3, type:'morning' },
      { schoolId:2, name:'Nyali–Bamburi Route', description:'Covers Nyali and Bamburi', vehicleId:5, driverId:9, type:'both' },
      { schoolId:3, name:'Milimani–CBD Route', description:'Covers Milimani and Kisumu CBD', vehicleId:7, driverId:12, type:'both' },
    ]);
    console.log('✅ 5 routes');
    await RouteStudent.bulkCreate([
      { routeId:1, studentId:1, stopOrder:1 }, { routeId:1, studentId:2, stopOrder:2 },
      { routeId:1, studentId:3, stopOrder:3 }, { routeId:1, studentId:4, stopOrder:4 },
      { routeId:2, studentId:5, stopOrder:1 }, { routeId:2, studentId:6, stopOrder:2 },
      { routeId:4, studentId:7, stopOrder:1 }, { routeId:4, studentId:8, stopOrder:2 },
      { routeId:5, studentId:9, stopOrder:1 }, { routeId:5, studentId:10, stopOrder:2 },
    ]);
    console.log('✅ 10 route-student assignments');
    const today = new Date().toISOString().split('T')[0];
    await Trip.bulkCreate([
      { routeId:1, driverId:3, vehicleId:1, status:'completed', type:'morning_pickup', scheduledDate:today, startedAt:new Date(`${today}T06:30:00`), endedAt:new Date(`${today}T07:45:00`) },
      { routeId:2, driverId:4, vehicleId:2, status:'in_progress', type:'morning_pickup', scheduledDate:today, startedAt:new Date(`${today}T06:45:00`) },
      { routeId:1, driverId:3, vehicleId:1, status:'scheduled', type:'afternoon_dropoff', scheduledDate:today },
      { routeId:2, driverId:4, vehicleId:2, status:'scheduled', type:'afternoon_dropoff', scheduledDate:today },
      { routeId:4, driverId:9, vehicleId:5, status:'scheduled', type:'afternoon_dropoff', scheduledDate:today },
    ]);
    console.log('✅ 5 trips');
    await TripLog.bulkCreate([
      { tripId:1, studentId:1, action:'check_in', timestamp:new Date(`${today}T06:35:00`) },
      { tripId:1, studentId:2, action:'check_in', timestamp:new Date(`${today}T06:37:00`) },
      { tripId:1, studentId:3, action:'check_in', timestamp:new Date(`${today}T06:50:00`) },
      { tripId:1, studentId:4, action:'absent', timestamp:new Date(`${today}T06:52:00`), notes:'Parent reported sick' },
      { tripId:2, studentId:5, action:'check_in', timestamp:new Date(`${today}T06:50:00`) },
    ]);
    console.log('✅ 5 trip logs');
    console.log('\n🎉 Seed complete!\n📋 Login: admin@nairobiacademy.co.ke / admin123');
    console.log('   Driver: driver1@nairobiacademy.co.ke / driver123');
    console.log('   Parent: parent1@gmail.com / parent123');
    process.exit(0);
  } catch (err) { console.error('❌ Seed failed:', err); process.exit(1); }
})();
