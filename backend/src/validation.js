const { body, param, validationResult } = require('express-validator');
const logger = require('./logger');

/**
 * Middleware to handle validation errors
 */
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    logger.logSecurity('validation_failed', {
      errors: errors.array(),
      path: req.path,
      ip: req.ip
    });
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: 'Invalid input data',
      details: errors.array()
    });
  }
  next();
};

/**
 * Sanitization helper - removes potentially dangerous characters
 */
const sanitizeString = (str) => {
  if (!str) return '';
  return String(str)
    .trim()
    .replace(/[<>]/g, '') // Remove angle brackets (XSS prevention)
    .substring(0, 500); // Max 500 chars
};

/**
 * Validation rules for verification endpoint
 */
const validateVerification = [
  param('saleId')
    .isString()
    .trim()
    .isLength({ min: 1, max: 100 })
    .matches(/^[a-zA-Z0-9\-_]+$/)
    .withMessage('Invalid sale ID format'),

  body('clerkId')
    .isString()
    .trim()
    .isLength({ min: 1, max: 100 })
    .withMessage('Clerk ID is required and must be under 100 characters'),

  body('scan.approved')
    .isBoolean()
    .withMessage('scan.approved must be a boolean'),

  body('scan.firstName')
    .optional()
    .isString()
    .trim()
    .isLength({ max: 100 })
    .withMessage('First name must be under 100 characters'),

  body('scan.lastName')
    .optional()
    .isString()
    .trim()
    .isLength({ max: 100 })
    .withMessage('Last name must be under 100 characters'),

  body('scan.middleName')
    .optional()
    .isString()
    .trim()
    .isLength({ max: 100 })
    .withMessage('Middle name must be under 100 characters'),

  body('scan.dob')
    .optional()
    .isString()
    .matches(/^\d{4}-\d{2}-\d{2}$/)
    .withMessage('Date of birth must be in YYYY-MM-DD format and valid')
    .custom((value) => {
      const date = new Date(value);
      const now = new Date();
      const minDate = new Date('1900-01-01');

      // Check if date is valid
      if (isNaN(date.getTime())) {
        throw new Error('Invalid date format');
      }

      // Check if date is in the future
      if (date > now) {
        throw new Error('Date of birth cannot be in the future');
      }

      // Check if date is too old (before 1900)
      if (date < minDate) {
        throw new Error('Date of birth is too old');
      }

      return true;
    })
    .withMessage('Date of birth must be in YYYY-MM-DD format and valid'),

  body('scan.age')
    .optional()
    .isInt({ min: 0, max: 150 })
    .withMessage('Age must be between 0 and 150'),

  body('scan.documentType')
    .optional()
    .isString()
    .trim()
    .isLength({ min: 1, max: 50 })
    .matches(/^[a-zA-Z0-9_\-]+$/)
    .withMessage('Document type must be a short alphanumeric label'),

  body('scan.documentNumber')
    .optional()
    .isString()
    .trim()
    .isLength({ min: 1, max: 120 })
    .withMessage('Document number must be between 1 and 120 characters'),

  body('scan.issuingCountry')
    .optional()
    .isString()
    .trim()
    .isLength({ max: 120 })
    .withMessage('Issuing country/jurisdiction must be under 120 characters'),

  body('scan.documentExpiry')
    .optional()
    .isString()
    .matches(/^\d{4}-\d{2}-\d{2}$/)
    .withMessage('documentExpiry must be in YYYY-MM-DD format'),

  body('scan.nationality')
    .optional()
    .isString()
    .trim()
    .isLength({ max: 120 })
    .withMessage('Nationality must be under 120 characters'),

  body('scan.sex')
    .optional()
    .isString()
    .trim()
    .isLength({ max: 10 })
    .withMessage('Sex marker must be under 10 characters'),

  body('scan.source')
    .optional()
    .isString()
    .trim()
    .isLength({ min: 1, max: 50 })
    .withMessage('Source must be a short identifier'),

  body('scan.reason')
    .optional()
    .isString()
    .trim()
    .isLength({ max: 500 })
    .withMessage('Reason must be under 500 characters'),

  handleValidationErrors
];

/**
 * Validation rules for completion endpoint
 */
const validateCompletion = [
  param('saleId')
    .isString()
    .trim()
    .isLength({ min: 1, max: 100 })
    .matches(/^[a-zA-Z0-9\-_]+$/)
    .withMessage('Invalid sale ID format'),

  body('verificationId')
    .isString()
    .trim()
    .isLength({ min: 1, max: 100 })
    .withMessage('Verification ID is required'),

  body('paymentType')
    .isString()
    .trim()
    .isIn(['cash', 'card'])
    .withMessage('Payment type must be either "cash" or "card"'),

  handleValidationErrors
];

/**
 * Validation rules for sale ID parameter
 */
const validateSaleId = [
  param('saleId')
    .isString()
    .trim()
    .isLength({ min: 1, max: 100 })
    .matches(/^[a-zA-Z0-9\-_]+$/)
    .withMessage('Invalid sale ID format'),

  handleValidationErrors
];

const validateBannedCreate = [
  body('documentType')
    .isString()
    .trim()
    .isLength({ min: 1, max: 50 })
    .matches(/^[a-zA-Z0-9_\-]+$/)
    .withMessage('documentType must be alphanumeric'),

  body('documentNumber')
    .isString()
    .trim()
    .isLength({ min: 1, max: 150 })
    .withMessage('documentNumber must be between 1 and 150 characters'),

  body('issuingCountry')
    .optional()
    .isString()
    .trim()
    .isLength({ max: 120 })
    .withMessage('issuingCountry must be under 120 characters'),

  body('dateOfBirth')
    .optional()
    .isString()
    .matches(/^\d{4}-\d{2}-\d{2}$/)
    .withMessage('dateOfBirth must be YYYY-MM-DD if provided'),

  body('firstName')
    .optional()
    .isString()
    .trim()
    .isLength({ max: 100 })
    .withMessage('firstName must be under 100 characters'),

  body('lastName')
    .optional()
    .isString()
    .trim()
    .isLength({ max: 100 })
    .withMessage('lastName must be under 100 characters'),

  body('notes')
    .optional()
    .isString()
    .trim()
    .isLength({ max: 500 })
    .withMessage('notes must be under 500 characters'),

  handleValidationErrors
];

const validateOverride = [
  param('saleId')
    .isString()
    .trim()
    .isLength({ min: 1, max: 100 })
    .matches(/^[a-zA-Z0-9\-_]+$/)
    .withMessage('Invalid sale ID format'),

  body('verificationId')
    .isString()
    .trim()
    .isLength({ min: 1, max: 100 })
    .withMessage('verificationId is required'),

  body('managerPin')
    .isString()
    .trim()
    .isLength({ min: 1, max: 100 })
    .withMessage('managerPin is required'),

  body('managerId')
    .optional()
    .isString()
    .trim()
    .isLength({ max: 100 })
    .withMessage('managerId must be under 100 characters'),

  body('note')
    .optional()
    .isString()
    .trim()
    .isLength({ max: 500 })
    .withMessage('note must be under 500 characters'),

  handleValidationErrors
];

const validateBannedId = [
  param('id')
    .isUUID()
    .withMessage('Invalid banned customer id'),
  handleValidationErrors
];

module.exports = {
  handleValidationErrors,
  sanitizeString,
  validateVerification,
  validateCompletion,
  validateSaleId,
  validateBannedCreate,
  validateBannedId,
  validateOverride
};
