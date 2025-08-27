export function extractToken(authHeader: string | undefined): string | null {
  if (!authHeader) {
    return null;
  }
  
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return null;
  }
  
  return parts[1];
}

export function decodeJWT(token: string): { user: { id: string } | null; error: any } {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new Error('Invalid JWT format');
    }
    
    const payload = JSON.parse(atob(parts[1]));
    
    return { 
      user: { id: payload.sub }, 
      error: null 
    };
  } catch (error: any) {
    return { 
      user: null, 
      error: { message: error.message || 'Invalid JWT token' } 
    };
  }
}

export function validateAuthToken(authHeader: string | undefined): { userId: string | null; error: any } {
  const token = extractToken(authHeader);
  
  if (!token) {
    return { 
      userId: null, 
      error: { message: 'No authorization token provided' } 
    };
  }
  
  const { user, error } = decodeJWT(token);
  
  if (error || !user) {
    return { 
      userId: null, 
      error: error || { message: 'Failed to decode token' } 
    };
  }
  
  return { userId: user.id, error: null };
}