require('dotenv').config();
const {
  sequelize,
  School,
  User,
  Vehicle,
  Student,
  Route,
  RouteStudent,
  Trip,
  TripLog,
} = require('../models');
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
    const [nairobiSchool, mombasaSchool, kisumuSchool] = schools;
    console.log(`✅ ${schools.length} schools`);
    const users = await User.bulkCreate([
      { email:'superadmin@carribu.io', passwordHash:'super123', firstName:'Super', lastName:'Admin', role:'super_admin', phone:'+254700000000' },
      { schoolId:nairobiSchool.id, email:'admin@nairobiacademy.co.ke', passwordHash:'admin123', firstName:'Alice', lastName:'Mwangi', role:'school_admin', phone:'+254711000001' },
      { schoolId:nairobiSchool.id, email:'coordinator@nairobiacademy.co.ke', passwordHash:'coord123', firstName:'Brian', lastName:'Ochieng', role:'coordinator', phone:'+254711000002' },
      { schoolId:nairobiSchool.id, email:'driver1@nairobiacademy.co.ke', passwordHash:'driver123', firstName:'Charles', lastName:'Mutua', role:'driver', phone:'+254711000003' },
      { schoolId:nairobiSchool.id, email:'driver2@nairobiacademy.co.ke', passwordHash:'driver123', firstName:'David', lastName:'Wanjiru', role:'driver', phone:'+254711000004' },
      { schoolId:nairobiSchool.id, email:'parent1@gmail.com', passwordHash:'parent123', firstName:'Esther', lastName:'Kamau', role:'parent', phone:'+254711000005', pickupAddress:'Westlands, Nairobi', pickupLat:-1.2641, pickupLng:36.8053 },
      { schoolId:nairobiSchool.id, email:'parent2@gmail.com', passwordHash:'parent123', firstName:'Francis', lastName:'Njoroge', role:'parent', phone:'+254711000006', pickupAddress:'Kilimani, Nairobi', pickupLat:-1.2888, pickupLng:36.7845 },
      { schoolId:nairobiSchool.id, email:'parent3@gmail.com', passwordHash:'parent123', firstName:'Grace', lastName:'Otieno', role:'parent', phone:'+254711000007', pickupAddress:'South B, Nairobi', pickupLat:-1.3092, pickupLng:36.8345 },
      { schoolId:mombasaSchool.id, email:'admin@mombasainternational.co.ke', passwordHash:'admin123', firstName:'Hassan', lastName:'Ahmed', role:'school_admin', phone:'+254711000008' },
      { schoolId:mombasaSchool.id, email:'driver1@mombasainternational.co.ke', passwordHash:'driver123', firstName:'Ibrahim', lastName:'Said', role:'driver', phone:'+254711000009' },
      { schoolId:mombasaSchool.id, email:'parent4@gmail.com', passwordHash:'parent123', firstName:'Jamila', lastName:'Omar', role:'parent', phone:'+254711000010', pickupAddress:'Nyali, Mombasa', pickupLat:-4.0225, pickupLng:39.7103 },
      { schoolId:kisumuSchool.id, email:'admin@kisumulakeside.co.ke', passwordHash:'admin123', firstName:'Kevin', lastName:'Onyango', role:'school_admin', phone:'+254711000011' },
      { schoolId:kisumuSchool.id, email:'driver1@kisumulakeside.co.ke', passwordHash:'driver123', firstName:'Lilian', lastName:'Auma', role:'driver', phone:'+254711000012' },
    ], { individualHooks: true });
    const userByEmail = new Map(users.map(user => [user.email, user]));
    const parent1 = userByEmail.get('parent1@gmail.com');
    const parent2 = userByEmail.get('parent2@gmail.com');
    const parent3 = userByEmail.get('parent3@gmail.com');
    const parent4 = userByEmail.get('parent4@gmail.com');
    const driver1Nairobi = userByEmail.get('driver1@nairobiacademy.co.ke');
    const driver2Nairobi = userByEmail.get('driver2@nairobiacademy.co.ke');
    const driverMombasa = userByEmail.get('driver1@mombasainternational.co.ke');
    const driverKisumu = userByEmail.get('driver1@kisumulakeside.co.ke');
    console.log(`✅ ${users.length} users (passwords hashed)`);
    const vehicles = await Vehicle.bulkCreate([
      { schoolId:nairobiSchool.id, plateNumber:'KDA 001A', make:'Toyota', model:'HiAce', year:2022, capacity:18, color:'White', status:'active', insuranceExpiry:'2027-03-15' },
      { schoolId:nairobiSchool.id, plateNumber:'KDA 002B', make:'Isuzu', model:'NQR', year:2021, capacity:33, color:'Yellow', status:'active', insuranceExpiry:'2027-06-20' },
      { schoolId:nairobiSchool.id, plateNumber:'KDA 003C', make:'Toyota', model:'Coaster', year:2023, capacity:29, color:'Blue', status:'active', insuranceExpiry:'2027-09-01' },
      { schoolId:nairobiSchool.id, plateNumber:'KDA 004D', make:'Nissan', model:'Civilian', year:2019, capacity:25, color:'White', status:'maintenance', insuranceExpiry:'2026-12-31' },
      { schoolId:mombasaSchool.id, plateNumber:'KCA 010X', make:'Toyota', model:'Coaster', year:2023, capacity:29, color:'Green', status:'active', insuranceExpiry:'2027-05-15' },
      { schoolId:mombasaSchool.id, plateNumber:'KCA 011Y', make:'Isuzu', model:'FRR', year:2022, capacity:40, color:'Orange', status:'active', insuranceExpiry:'2027-08-30' },
      { schoolId:kisumuSchool.id, plateNumber:'KBZ 020M', make:'Toyota', model:'HiAce', year:2021, capacity:18, color:'Silver', status:'active', insuranceExpiry:'2027-04-10' },
      { schoolId:kisumuSchool.id, plateNumber:'KBZ 021N', make:'Mitsubishi', model:'Rosa', year:2020, capacity:28, color:'White', status:'active', insuranceExpiry:'2027-01-25' },
    ]);
    const [vehicle1, vehicle2, vehicle3, , vehicle5, , vehicle7] = vehicles;
    console.log(`✅ ${vehicles.length} vehicles`);
    const students = await Student.bulkCreate([
      { schoolId:nairobiSchool.id, parentId:parent1.id, firstName:'Amani', lastName:'Kamau', grade:'Grade 3' },
      { schoolId:nairobiSchool.id, parentId:parent1.id, firstName:'Baraka', lastName:'Kamau', grade:'Grade 5' },
      { schoolId:nairobiSchool.id, parentId:parent2.id, firstName:'Ciku', lastName:'Njoroge', grade:'Grade 2' },
      { schoolId:nairobiSchool.id, parentId:parent2.id, firstName:'Diani', lastName:'Njoroge', grade:'Grade 4' },
      { schoolId:nairobiSchool.id, parentId:parent3.id, firstName:'Erick', lastName:'Otieno', grade:'Grade 1' },
      { schoolId:nairobiSchool.id, parentId:parent3.id, firstName:'Faith', lastName:'Otieno', grade:'Grade 6' },
      { schoolId:mombasaSchool.id, parentId:parent4.id, firstName:'Ghali', lastName:'Omar', grade:'Grade 3' },
      { schoolId:mombasaSchool.id, parentId:parent4.id, firstName:'Halima', lastName:'Omar', grade:'Grade 5' },
      { schoolId:kisumuSchool.id, firstName:'Ian', lastName:'Odhiambo', grade:'Grade 2' },
      { schoolId:kisumuSchool.id, firstName:'Joyce', lastName:'Adhiambo', grade:'Grade 4' },
    ]);
    const [student1, student2, student3, student4, student5, student6, student7, student8, student9, student10] = students;
    console.log(`✅ ${students.length} students`);
    const routes = await Route.bulkCreate([
      { schoolId:nairobiSchool.id, name:'Westlands–Kilimani Route', description:'Covers Westlands and Kilimani', vehicleId:vehicle1.id, driverId:driver1Nairobi.id, type:'both' },
      { schoolId:nairobiSchool.id, name:'South B–South C Route', description:'Covers South B and South C', vehicleId:vehicle2.id, driverId:driver2Nairobi.id, type:'both' },
      { schoolId:nairobiSchool.id, name:'Karen–Langata Route', description:'Covers Karen and Langata', vehicleId:vehicle3.id, driverId:driver1Nairobi.id, type:'morning' },
      { schoolId:mombasaSchool.id, name:'Nyali–Bamburi Route', description:'Covers Nyali and Bamburi', vehicleId:vehicle5.id, driverId:driverMombasa.id, type:'both' },
      { schoolId:kisumuSchool.id, name:'Milimani–CBD Route', description:'Covers Milimani and Kisumu CBD', vehicleId:vehicle7.id, driverId:driverKisumu.id, type:'both' },
    ]);
    const [route1, route2, , route4, route5] = routes;
    console.log('✅ 5 routes');
    await RouteStudent.bulkCreate([
      { routeId:route1.id, studentId:student1.id, stopOrder:1 }, { routeId:route1.id, studentId:student2.id, stopOrder:2 },
      { routeId:route1.id, studentId:student3.id, stopOrder:3 }, { routeId:route1.id, studentId:student4.id, stopOrder:4 },
      { routeId:route2.id, studentId:student5.id, stopOrder:1 }, { routeId:route2.id, studentId:student6.id, stopOrder:2 },
      { routeId:route4.id, studentId:student7.id, stopOrder:1 }, { routeId:route4.id, studentId:student8.id, stopOrder:2 },
      { routeId:route5.id, studentId:student9.id, stopOrder:1 }, { routeId:route5.id, studentId:student10.id, stopOrder:2 },
    ]);
    console.log('✅ 10 route-student assignments');
    const today = new Date().toISOString().split('T')[0];
    const trips = await Trip.bulkCreate([
      { routeId:route1.id, driverId:driver1Nairobi.id, vehicleId:vehicle1.id, status:'completed', type:'morning_pickup', scheduledDate:today, startedAt:new Date(`${today}T06:30:00`), endedAt:new Date(`${today}T07:45:00`) },
      { routeId:route2.id, driverId:driver2Nairobi.id, vehicleId:vehicle2.id, status:'in_progress', type:'morning_pickup', scheduledDate:today, startedAt:new Date(`${today}T06:45:00`) },
      { routeId:route1.id, driverId:driver1Nairobi.id, vehicleId:vehicle1.id, status:'scheduled', type:'afternoon_dropoff', scheduledDate:today },
      { routeId:route2.id, driverId:driver2Nairobi.id, vehicleId:vehicle2.id, status:'scheduled', type:'afternoon_dropoff', scheduledDate:today },
      { routeId:route4.id, driverId:driverMombasa.id, vehicleId:vehicle5.id, status:'scheduled', type:'afternoon_dropoff', scheduledDate:today },
    ]);
    const [completedTrip, activeTrip] = trips;
    console.log('✅ 5 trips');
    await TripLog.bulkCreate([
      { tripId:completedTrip.id, studentId:student1.id, action:'check_in', timestamp:new Date(`${today}T06:35:00`) },
      { tripId:completedTrip.id, studentId:student2.id, action:'check_in', timestamp:new Date(`${today}T06:37:00`) },
      { tripId:completedTrip.id, studentId:student3.id, action:'check_in', timestamp:new Date(`${today}T06:50:00`) },
      { tripId:completedTrip.id, studentId:student4.id, action:'absent', timestamp:new Date(`${today}T06:52:00`), notes:'Parent reported sick' },
      { tripId:activeTrip.id, studentId:student5.id, action:'check_in', timestamp:new Date(`${today}T06:50:00`) },
    ]);
    console.log('✅ 5 trip logs');
    console.log('\n🎉 Seed complete!\n📋 Login: superadmin@carribu.io / super123 (super_admin)');
    console.log('   School Admin: admin@nairobiacademy.co.ke / admin123');
    console.log('   Driver: driver1@nairobiacademy.co.ke / driver123');
    console.log('   Parent: parent1@gmail.com / parent123');
    process.exit(0);
  } catch (err) { console.error('❌ Seed failed:', err); process.exit(1); }
})();
