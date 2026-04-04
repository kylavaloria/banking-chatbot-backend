import { serviceClient } from '../config/supabase';

export interface CustomerRecord {
  customer_id: string;
  auth_user_id: string | null;
  external_customer_ref: string | null;
  full_name: string | null;
  email: string;
  mobile_number: string | null;
  segment: string | null;
  created_at: string;
  updated_at: string;
}

interface ServiceError {
  status: number;
  message: string;
}

function serviceError(status: number, message: string): ServiceError {
  return { status, message };
}

/**
 * Resolves a Supabase auth identity to a pre-encoded customer record.
 * Implements the SRS binding rules:
 *   - No record for email         → deny (403)
 *   - auth_user_id is null        → bind and allow
 *   - auth_user_id matches        → allow
 *   - auth_user_id does not match → deny (403)
 */
export async function resolveCustomer(
  authUserId: string,
  email: string
): Promise<CustomerRecord> {
  const { data, error } = await serviceClient
    .from('customers')
    .select('*')
    .eq('email', email)
    .maybeSingle();

  if (error) {
    throw serviceError(500, 'Database error during customer lookup.');
  }

  if (!data) {
    throw serviceError(
      403,
      'Access denied: no pre-encoded customer record found for this email.'
    );
  }

  const customer = data as CustomerRecord;

  // First login: bind the Supabase auth_user_id to this customer record.
  if (customer.auth_user_id === null) {
    const { error: updateError } = await serviceClient
      .from('customers')
      .update({
        auth_user_id: authUserId,
        updated_at: new Date().toISOString(),
      })
      .eq('customer_id', customer.customer_id);

    if (updateError) {
      throw serviceError(500, 'Failed to bind auth identity to customer record.');
    }

    customer.auth_user_id = authUserId;
    return customer;
  }

  // Subsequent logins: validate the stored identity matches.
  if (customer.auth_user_id !== authUserId) {
    throw serviceError(
      403,
      'Access denied: authenticated identity does not match the customer record.'
    );
  }

  return customer;
}