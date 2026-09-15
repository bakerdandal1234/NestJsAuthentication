import {
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
} from 'class-validator';

// 

@ValidatorConstraint({ name: 'isGreaterThan', async: false })
export class IsGreaterThan implements ValidatorConstraintInterface {
  validate(value: number, args: ValidationArguments): boolean {
    const [relatedPropertyName] = args.constraints;

    const object = args.object as Record<string, unknown>;
    const relatedValue = object[relatedPropertyName];

    return (
      typeof value === 'number' &&
      typeof relatedValue === 'number' &&
      value > relatedValue
    );
  }

  defaultMessage(args: ValidationArguments): string {
    const [relatedPropertyName] = args.constraints;

    return `${args.property} must be greater than ${relatedPropertyName}`;
  }
}