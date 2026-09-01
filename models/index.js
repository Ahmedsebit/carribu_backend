const sequelize = require('../config/database');
const School = require('./School');
const User = require('./User');
const Vehicle = require('./Vehicle');
const Student = require('./Student');
const Route = require('./Route');
const RouteStudent = require('./RouteStudent');
const RouteWaypoint = require('./RouteWaypoint');
const Trip = require('./Trip');
const TripLog = require('./TripLog');
const Message = require('./Message');
const BusLocation = require('./BusLocation');
const AppVersion = require('./AppVersion');
const AuditLog = require('./AuditLog');
const Subscription = require('./Subscription');
const ParentSchool = require('./ParentSchool');

School.belongsTo(User, { foreignKey: 'managed_by', as: 'manager' });
User.hasMany(School, { foreignKey: 'managed_by', as: 'managedSchools' });

School.hasMany(User, { foreignKey: 'school_id', as: 'users' });
School.hasMany(Vehicle, { foreignKey: 'school_id', as: 'vehicles' });
School.hasMany(Student, { foreignKey: 'school_id', as: 'students' });
School.hasMany(Route, { foreignKey: 'school_id', as: 'routes' });
School.hasMany(Message, { foreignKey: 'school_id', as: 'messages' });

User.belongsTo(School, { foreignKey: 'school_id', as: 'school' });
User.hasMany(Student, { foreignKey: 'parent_id', as: 'children' });
User.hasMany(Route, { foreignKey: 'driver_id', as: 'assignedRoutes', onDelete: 'SET NULL' });
User.hasMany(Trip, { foreignKey: 'driver_id', as: 'trips', onDelete: 'SET NULL' });
User.hasMany(Message, { foreignKey: 'sender_id', as: 'sentMessages' });
User.hasMany(Message, { foreignKey: 'receiver_id', as: 'receivedMessages' });
User.hasMany(ParentSchool, { foreignKey: 'parent_id', as: 'schoolMemberships', onDelete: 'CASCADE' });
User.belongsToMany(School, {
  through: ParentSchool,
  foreignKey: 'parent_id',
  otherKey: 'school_id',
  as: 'parentSchools',
});
School.hasMany(ParentSchool, { foreignKey: 'school_id', as: 'parentMemberships', onDelete: 'CASCADE' });
School.belongsToMany(User, {
  through: ParentSchool,
  foreignKey: 'school_id',
  otherKey: 'parent_id',
  as: 'parentUsers',
});
ParentSchool.belongsTo(User, { foreignKey: 'parent_id', as: 'parent' });
ParentSchool.belongsTo(School, { foreignKey: 'school_id', as: 'school' });

Vehicle.belongsTo(School, { foreignKey: 'school_id', as: 'school' });
Vehicle.hasMany(Route, { foreignKey: 'vehicle_id', as: 'routes' });
Vehicle.hasMany(Trip, { foreignKey: 'vehicle_id', as: 'trips' });
Vehicle.hasMany(BusLocation, { foreignKey: 'vehicle_id', as: 'locations' });

Student.belongsTo(School, { foreignKey: 'school_id', as: 'school' });
Student.belongsTo(User, { foreignKey: 'parent_id', as: 'parent' });
Student.belongsToMany(Route, { through: RouteStudent, foreignKey: 'student_id', otherKey: 'route_id', as: 'routes' });
Student.hasMany(TripLog, { foreignKey: 'student_id', as: 'tripLogs' });

Route.belongsTo(School, { foreignKey: 'school_id', as: 'school' });
Route.belongsTo(Vehicle, { foreignKey: 'vehicle_id', as: 'vehicle' });
Route.belongsTo(User, { foreignKey: 'driver_id', as: 'driver', onDelete: 'SET NULL' });
Route.belongsToMany(Student, { through: RouteStudent, foreignKey: 'route_id', otherKey: 'student_id', as: 'students' });
Route.hasMany(Trip, { foreignKey: 'route_id', as: 'trips' });
Route.hasMany(RouteWaypoint, { foreignKey: 'route_id', as: 'routeWaypoints' });
RouteWaypoint.belongsTo(Route, { foreignKey: 'route_id', as: 'route' });

Trip.belongsTo(Route, { foreignKey: 'route_id', as: 'route' });
Trip.belongsTo(User, { foreignKey: 'driver_id', as: 'driver', onDelete: 'SET NULL' });
Trip.belongsTo(Vehicle, { foreignKey: 'vehicle_id', as: 'vehicle' });
Trip.hasMany(TripLog, { foreignKey: 'trip_id', as: 'logs' });
Trip.hasMany(Message, { foreignKey: 'trip_id', as: 'messages' });
Trip.hasMany(BusLocation, { foreignKey: 'trip_id', as: 'locations' });

TripLog.belongsTo(Trip, { foreignKey: 'trip_id', as: 'trip' });
TripLog.belongsTo(Student, { foreignKey: 'student_id', as: 'student' });

Message.belongsTo(School, { foreignKey: 'school_id', as: 'school' });
Message.belongsTo(User, { foreignKey: 'sender_id', as: 'sender' });
Message.belongsTo(User, { foreignKey: 'receiver_id', as: 'receiver' });
Message.belongsTo(Trip, { foreignKey: 'trip_id', as: 'trip' });

BusLocation.belongsTo(Trip, { foreignKey: 'trip_id', as: 'trip' });
BusLocation.belongsTo(Vehicle, { foreignKey: 'vehicle_id', as: 'vehicle' });
BusLocation.belongsTo(User, { foreignKey: 'driver_id', as: 'driver', onDelete: 'SET NULL' });

RouteStudent.belongsTo(Route, { foreignKey: 'route_id', as: 'route' });
RouteStudent.belongsTo(Student, { foreignKey: 'student_id', as: 'student' });

AuditLog.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
AuditLog.belongsTo(School, { foreignKey: 'school_id', as: 'school' });

Subscription.belongsTo(School, { foreignKey: 'school_id', as: 'school' });
School.hasOne(Subscription, { foreignKey: 'school_id', as: 'subscription' });

module.exports = { sequelize, School, User, ParentSchool, Vehicle, Student, Route, RouteStudent, RouteWaypoint, Trip, TripLog, Message, BusLocation, AppVersion, AuditLog, Subscription };
